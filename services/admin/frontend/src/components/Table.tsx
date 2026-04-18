import React, { useMemo, useState } from 'react';

// Generic data table.  Supports:
//   - fixed column widths (via the `width` prop) so long monospace values
//     ellipsis instead of wrapping
//   - click-to-copy for identifier cells (cardRef, key ARNs, hashes)
//   - client-side search across caller-selected columns
//   - single-click row selection with onRowClick (for drawer-style details)

export interface Column<T> {
  key: string;
  header: React.ReactNode;
  width?: string;
  mono?: boolean;
  copyable?: (row: T) => string | null;
  render: (row: T) => React.ReactNode;
  sort?: (row: T) => string | number;
  align?: 'left' | 'right' | 'center';
}

export interface TableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  onRowClick?: (row: T) => void;
  activeRowKey?: string | null;
  searchPlaceholder?: string;
  searchMatch?: (row: T, query: string) => boolean;
  toolbarExtra?: React.ReactNode;
  empty?: React.ReactNode;
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  onRowClick,
  activeRowKey,
  searchPlaceholder,
  searchMatch,
  toolbarExtra,
  empty,
}: TableProps<T>) {
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || !searchMatch) return rows;
    return rows.filter((r) => searchMatch(r, q));
  }, [rows, query, searchMatch]);

  const sorted = useMemo(() => {
    if (!sortKey) return filtered;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sort) return filtered;
    const sort = col.sort;
    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      const av = sort(a);
      const bv = sort(b);
      if (av < bv) return -1 * dir;
      if (av > bv) return 1 * dir;
      return 0;
    });
  }, [filtered, columns, sortKey, sortDir]);

  const showToolbar = Boolean(searchMatch) || toolbarExtra;

  return (
    <div>
      {showToolbar && (
        <div className="vera-toolbar">
          {searchMatch && (
            <input
              className="search"
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={searchPlaceholder ?? 'Search…'}
            />
          )}
          {toolbarExtra}
        </div>
      )}

      {sorted.length === 0 ? (
        empty ?? <p className="small">No rows.</p>
      ) : (
        <table className="vera-table">
          <colgroup>
            {columns.map((c) => (
              <col key={c.key} style={c.width ? { width: c.width } : undefined} />
            ))}
          </colgroup>
          <thead>
            <tr>
              {columns.map((c) => (
                <th
                  key={c.key}
                  style={{
                    textAlign: c.align ?? 'left',
                    cursor: c.sort ? 'pointer' : 'default',
                  }}
                  onClick={() => {
                    if (!c.sort) return;
                    if (sortKey === c.key) {
                      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
                    } else {
                      setSortKey(c.key);
                      setSortDir('asc');
                    }
                  }}
                >
                  {c.header}
                  {c.sort && sortKey === c.key && (
                    <span style={{ marginLeft: 4 }}>{sortDir === 'asc' ? '▲' : '▼'}</span>
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {sorted.map((row) => {
              const key = rowKey(row);
              const isActive = activeRowKey === key;
              const clickable = Boolean(onRowClick);
              return (
                <tr
                  key={key}
                  className={[
                    clickable ? 'clickable' : '',
                    isActive ? 'active' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onClick={clickable ? () => onRowClick!(row) : undefined}
                >
                  {columns.map((c) => (
                    <Cell key={c.key} column={c} row={row} />
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}

function Cell<T>({ column, row }: { column: Column<T>; row: T }) {
  const [copied, setCopied] = useState(false);
  const copyValue = column.copyable?.(row) ?? null;
  const content = column.render(row);
  const align = column.align ?? 'left';
  const style: React.CSSProperties = {
    textAlign: align,
    fontFamily: column.mono ? 'ui-monospace, "SF Mono", Menlo, monospace' : undefined,
    fontSize: column.mono ? 13 : undefined,
  };

  if (copyValue) {
    const titleHint = copied ? 'Copied' : `Click to copy: ${copyValue}`;
    return (
      <td
        style={style}
        title={titleHint}
        onClick={(e) => {
          e.stopPropagation();
          navigator.clipboard?.writeText(copyValue).then(
            () => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            },
            () => {},
          );
        }}
      >
        <span className="cell-copy">
          {content}
          {copied && <span className="copy-flash">✓</span>}
        </span>
      </td>
    );
  }

  return (
    <td style={style} title={typeof content === 'string' ? content : undefined}>
      {content}
    </td>
  );
}
