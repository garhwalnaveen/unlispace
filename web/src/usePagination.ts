import { useCallback, useEffect, useRef, useState } from "react";
import type { DriveApi } from "./api";

function usePages<T>(
  load: (
    cursor: string | null,
  ) => Promise<{ items: T[]; cursor: string | null }>,
) {
  const [items, setItems] = useState<T[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>();
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const pending = useRef(false);
  const shown = useRef<typeof load | null>(null);
  useEffect(() => {
    const current = ++generation.current;
    pending.current = true;
    // A reload of the same place keeps what is on screen until the fresh page arrives.
    if (shown.current !== load) {
      shown.current = load;
      setItems([]);
      setCursor(null);
    }
    setLoading(true);
    setError(undefined);
    void load(null)
      .then((page) => {
        if (current === generation.current) {
          setItems(page.items);
          setCursor(page.cursor);
        }
      })
      .catch((reason) => {
        if (current === generation.current) {
          setItems([]);
          setCursor(null);
          setError(reason);
        }
      })
      .finally(() => {
        if (current === generation.current) {
          pending.current = false;
          setLoading(false);
        }
      });
    return () => {
      ++generation.current;
    };
  }, [load, revision]);
  const loadMore = useCallback(async () => {
    if (!cursor || pending.current) return;
    const current = generation.current;
    pending.current = true;
    setLoading(true);
    setError(undefined);
    try {
      const page = await load(cursor);
      if (current === generation.current) {
        if (page.cursor === cursor)
          throw new Error(
            "The server returned the same pagination cursor. Please reload.",
          );
        setItems((previous) => [...previous, ...page.items]);
        setCursor(page.cursor);
      }
    } catch (reason) {
      if (current === generation.current) setError(reason);
    } finally {
      if (current === generation.current) {
        pending.current = false;
        setLoading(false);
      }
    }
  }, [load, cursor]);
  return {
    items,
    cursor,
    loading,
    error,
    loadMore,
    reload: () => setRevision((value) => value + 1),
  };
}
export function useListing(api: DriveApi, path: string) {
  const load = useCallback(
    async (cursor: string | null) => {
      const page = await api.list(path, cursor);
      return { items: page.entries, cursor: page.cursor };
    },
    [api, path],
  );
  const page = usePages(load);
  return { ...page, entries: page.items };
}
export function useVersions(api: DriveApi, path: string) {
  const load = useCallback(
    async (cursor: string | null) => {
      const page = await api.versions(path, cursor);
      return { items: page.versions, cursor: page.cursor };
    },
    [api, path],
  );
  const page = usePages(load);
  return { ...page, versions: page.items };
}
/** Whole-drive name search. Idle (no request) until `query` has the three characters the data plane needs. */
export function useSearch(api: DriveApi, query: string) {
  const active = [...query].length >= 3;
  const load = useCallback(
    async (cursor: string | null) => {
      if (!active) return { items: [], cursor: null };
      const page = await api.search(query, cursor);
      return { items: page.entries, cursor: page.cursor };
    },
    [api, query, active],
  );
  const page = usePages(load);
  return { ...page, results: page.items, active };
}
