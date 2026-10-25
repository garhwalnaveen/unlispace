//! Time selection and atomic subtree rollback shared by the CLI and integration tests.
use anyhow::{Result, bail, Context};
use uls_client::{Client, Error};
use uls_proto::{Op, VersionEntry};

/// Strict RFC3339, including fractional seconds and explicit UTC offsets; returns epoch ms.
pub fn instant(s: &str) -> Result<i64> {
    fn invalid() -> anyhow::Error { anyhow::anyhow!("expected an RFC3339 timestamp") }
    fn number(s: &str) -> Result<i64> { if s.is_empty() || !s.bytes().all(|c| c.is_ascii_digit()) { return Err(invalid()); } Ok(s.parse()?) }
    if !s.is_ascii() || s.len() < 20 { return Err(invalid()); }
    if &s[4..5] != "-" || &s[7..8] != "-" || !matches!(&s[10..11], "T" | "t") || &s[13..14] != ":" || &s[16..17] != ":" { return Err(invalid()); }
    let y = number(&s[..4])?;
    let m = number(&s[5..7])?;
    let d = number(&s[8..10])?;
    let h = number(&s[11..13])?;
    let min = number(&s[14..16])?;
    let sec = number(&s[17..19])?;
    let leap = y % 4 == 0 && (y % 100 != 0 || y % 400 == 0);
    let days = match m { 1|3|5|7|8|10|12 => 31, 4|6|9|11 => 30, 2 => if leap {29} else {28}, _ => return Err(invalid()) };
    if d < 1 || d > days || h > 23 || min > 59 || sec > 59 { return Err(invalid()); }
    let mut tail = &s[19..];
    let mut fraction = 0;
    if tail.starts_with('.') {
        let n = tail[1..].bytes().take_while(u8::is_ascii_digit).count();
        if n == 0 { return Err(invalid()); }
        let digits = &tail[1..1+n];
        let millis = format!("{digits}000");
        fraction = number(&millis[..3])?;
        tail = &tail[1+n..];
    }
    let offset = if tail == "Z" || tail == "z" { 0 } else {
        if tail.len() != 6 || !matches!(&tail[..1], "+"|"-") || &tail[3..4] != ":" { return Err(invalid()); }
        let oh = number(&tail[1..3])?; let om = number(&tail[4..6])?;
        if oh > 23 || om > 59 { return Err(invalid()); }
        (oh*60+om)*60 * if tail.starts_with('-') {-1} else {1}
    };
    // Gregorian civil date to days since 1970-01-01.
    let y = y - i64::from(m <= 2);
    let era = y.div_euclid(400); let year = y - era*400;
    let month = m + if m > 2 {-3} else {9};
    let day = (153*month+2)/5+d-1;
    let epoch_days = era*146097 + year*365+year/4-year/100+day-719468;
    Ok((epoch_days*86400+h*3600+min*60+sec-offset)*1000+fraction)
}

pub async fn at(client: &Client, drive: &str, path: &str, ts: i64) -> Result<Option<VersionEntry>> {
    let selected = client.versions(drive,path).await?.into_iter().filter(|v| v.ts <= ts).max_by_key(|v| (v.ts,v.seq));
    if let Some(version) = &selected {
        let mut ancestor = path.trim_end_matches('/');
        while let Some((parent,_)) = ancestor.rsplit_once('/') {
            let deleted = client.versions(drive,&format!("{parent}/")).await?.into_iter().any(|v|v.op == "delete" && v.ts <= ts && (v.ts,v.seq) > (version.ts,version.seq));
            if deleted {return Ok(None);}
            ancestor = parent;
        }
    }
    Ok(selected)
}

pub async fn plan(client: &Client, drive: &str, folder: &str, ts: i64) -> Result<Vec<Op>> {
    let prefix = folder.trim_start_matches('/').trim_end_matches('/');
    let mut paths = std::collections::BTreeSet::new();
    let mut cursor = 0;
    loop {
        let page = client.changes(drive,cursor,1000).await?;
        for change in &page.changes {
            if prefix.is_empty() || change.path.trim_end_matches('/') == prefix || change.path.starts_with(&format!("{prefix}/")) { paths.insert(change.path.clone()); }
        }
        if !page.more { break; }
        let next = page.changes.last().context("empty change page with more=true")?.ev;
        if next <= cursor { bail!("change cursor did not advance"); } cursor = next;
    }
    let mut deletes = Vec::new(); let mut mkdirs = Vec::new(); let mut puts = Vec::new();
    for path in paths {
        let version = at(client,drive,&path,ts).await?;
        let current = match client.stat(drive,&path).await { Ok(s) => Some(s), Err(Error::NotFound { .. }) => None, Err(e) => return Err(e.into()) };
        let historical = version.filter(|v| v.op != "delete");
        match (historical,current) {
            (None,Some(s)) => deletes.push(Op::Delete {path,if_version:s.version_id}),
            (Some(v),current) => {
                if current.as_ref().and_then(|s| s.version_id.as_deref()) == Some(v.version_id.as_str()) { continue; }
                if v.op == "mkdir" || path.ends_with('/') {
                    if current.is_none() { mkdirs.push(Op::Mkdir {path}); }
                } else {
                    let m = client.manifest(drive,&path,Some(&v.version_id)).await?;
                    puts.push(Op::Put {path,if_version:current.as_ref().and_then(|s|s.version_id.clone()),if_absent:current.is_none(),size:m.size,content_type:m.content_type.unwrap_or_else(||"application/octet-stream".into()),mtime_ms:m.mtime_ms.unwrap_or(v.ts),shards:m.shards});
                }
            }
            (None,None) => {}
        }
    }
    deletes.sort_by_key(|op| match op { Op::Delete {path,..} => std::cmp::Reverse(path.len()), _ => unreachable!() });
    mkdirs.sort_by_key(|op| match op { Op::Mkdir {path} => path.len(), _ => unreachable!() });
    deletes.extend(mkdirs); deletes.extend(puts); Ok(deletes)
}

/// Deleted directories can be identified from the change feed even without a trailing slash.
pub async fn is_folder(client:&Client,drive:&str,path:&str)->Result<bool> {
    if path.is_empty() || path.ends_with('/') {return Ok(true);}
    match client.stat(drive,path).await {
        Ok(s) => return Ok(s.node_type == uls_proto::NodeType::Folder),
        Err(Error::NotFound {..}) => {},
        Err(e) => return Err(e.into()),
    }
    let versions=client.versions(drive,path).await?;
    if !versions.is_empty() {return Ok(versions.iter().any(|v|v.op == "mkdir"));}
    let prefix=format!("{}/",path.trim_start_matches('/'));
    let mut cursor=0;
    loop {
        let page=client.changes(drive,cursor,1000).await?;
        if page.changes.iter().any(|ch|ch.path.starts_with(&prefix)) {return Ok(true);}
        if !page.more {return Ok(false);}
        let next=page.changes.last().context("empty changes page")?.ev;
        if next <= cursor {bail!("change cursor did not advance");} cursor=next;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc3339_offsets_fractions_and_validation() {
        assert_eq!(instant("1970-01-01T00:00:00Z").unwrap(),0);
        assert_eq!(instant("1970-01-01T05:30:00.123456+05:30").unwrap(),123);
        assert_eq!(instant("1969-12-31T23:59:59Z").unwrap(),-1000);
        assert!(instant("2025-02-29T00:00:00Z").is_err());
        assert!(instant("2024-02-29T00:00:00Z").is_ok());
        assert!(instant("2024-01-01T25:00:00Z").is_err());
        assert!(instant("2024-01-01T00:00:00").is_err());
    }
}

