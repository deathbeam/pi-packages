Search files using ripgrep. Every matched line returns as `LINE#HASH:content` — copy those anchors verbatim into `edit` without a prior `read`.

The `pattern` is a regular expression unless `literal: true`. Results include hidden files except `.git` metadata and respect `.gitignore`. Use `path` to scope to a file or directory; use `glob` to filter by filename pattern (e.g. `"**/*.ts"`).

Set `context` to include lines before and after each match (default 0). Set `limit` to cap matched lines (default 50, max 200).

When results are too broad, narrow in this order: read the match count first, then scope with `path`/`glob`, then tighten `pattern`, and only add `context` once the set is small. Result lines are capped at {{DEFAULT_MAX_BYTES}}/{{DEFAULT_MAX_LINES}} whole lines; the summary and notices follow outside that cap. When truncated, narrow the search and rerun.
