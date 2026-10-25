//! Local daemon RPC client. Events are ignored while waiting for the matching response.
use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

pub fn socket() -> Result<std::path::PathBuf> {
    Ok(std::env::var_os("ULS_SOCKET").map(Into::into).unwrap_or(crate::daemon::socket_path()?))
}

pub async fn call(method: &str, params: Value) -> Result<Value> {
    call_at(&socket()?, method, params).await
}

pub async fn call_at(socket: &std::path::Path, method: &str, params: Value) -> Result<Value> {
    let stream = tokio::net::UnixStream::connect(socket).await.context("connect to ulsd; run `uls daemon start`")?;
    let (rd, mut wr) = stream.into_split();
    wr.write_all(format!("{}\n", json!({"id":1,"method":method,"params":params})).as_bytes()).await?;
    let mut lines = BufReader::new(rd).lines();
    while let Some(line) = lines.next_line().await? {
        let value: Value = serde_json::from_str(&line)?;
        if value["id"] == 1 {
            if let Some(error) = value.get("error") {
                bail!("{}: {}", error["code"].as_str().unwrap_or("error"), error["message"].as_str().unwrap_or("request failed"));
            }
            return value.get("result").cloned().context("missing daemon result");
        }
    }
    bail!("daemon closed the connection")
}
