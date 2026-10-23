import { useMemo, useState } from 'react';

interface Props {
  files: string[];
  active: string | null;
  marks: Record<string, string>;
  findingsByFile: Record<string, number>;
  onOpen: (p: string) => void;
  onNew: () => void;
  onDelete: (p: string) => void;
}

interface Node {
  name: string;
  path: string;
  children: Node[];
  file: boolean;
}

function build(paths: string[]): Node[] {
  const root: Node = { name: '', path: '', children: [], file: false };
  for (const p of paths.sort()) {
    let cur = root;
    const parts = p.split('/');
    parts.forEach((seg, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let n = cur.children.find((c) => c.name === seg);
      if (!n) {
        n = { name: seg, path, children: [], file: i === parts.length - 1 };
        cur.children.push(n);
      }
      cur = n;
    });
  }
  const sort = (ns: Node[]) => {
    ns.sort((a, b) => (a.file === b.file ? a.name.localeCompare(b.name) : a.file ? 1 : -1));
    ns.forEach((n) => sort(n.children));
  };
  sort(root.children);
  return root.children;
}

export function FileTree({ files, active, marks, findingsByFile, onOpen, onNew, onDelete }: Props) {
  const tree = useMemo(() => build([...files]), [files]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const del = (path: string) => {
    if (window.confirm(`Delete ${path}?`)) onDelete(path);
  };
  const render = (ns: Node[], depth: number) =>
    ns.map((n) =>
      n.file ? (
        <li key={n.path} className={`row ${active === n.path ? 'on' : ''}`}>
          <button
            type="button"
            className="item"
            style={{ paddingLeft: 10 + depth * 14 }}
            aria-current={active === n.path ? 'true' : undefined}
            onClick={() => onOpen(n.path)}
            onContextMenu={(e) => {
              e.preventDefault();
              del(n.path);
            }}
            title={n.path}
          >
            <span aria-hidden="true">📄</span>
            <span className="name">{n.name}</span>
            {findingsByFile[n.path] ? (
              <span className="mark F">
                <span aria-hidden="true">●</span>
                {findingsByFile[n.path]}
                <span className="sr"> finding{findingsByFile[n.path] > 1 ? 's' : ''}</span>
              </span>
            ) : marks[n.path] ? (
              <span className={`mark ${marks[n.path]}`}>
                <span aria-hidden="true">{marks[n.path]}</span>
                <span className="sr">{marks[n.path] === 'U' ? ' untracked or added' : ' modified'}</span>
              </span>
            ) : null}
          </button>
          <button type="button" className="del" aria-label={`Delete ${n.path}`} title={`Delete ${n.path}`} onClick={() => del(n.path)}>
            <span aria-hidden="true">✕</span>
          </button>
        </li>
      ) : (
        <li key={n.path}>
          <button
            type="button"
            className="item dir"
            style={{ paddingLeft: 10 + depth * 14 }}
            aria-expanded={!closed[n.path]}
            onClick={() => setClosed((c) => ({ ...c, [n.path]: !c[n.path] }))}
          >
            <span aria-hidden="true">{closed[n.path] ? '▸' : '▾'}</span>
            <span>{n.name}</span>
          </button>
          {!closed[n.path] && <ul>{render(n.children, depth + 1)}</ul>}
        </li>
      ),
    );
  return (
    <nav className="tree" aria-label="Files in aeroshop-api">
      <div className="hdr">
        <span>Explorer · aeroshop-api</span>
        <button className="btn ghost sm" title="New file" aria-label="New file" onClick={onNew}>
          <span aria-hidden="true">＋</span>
        </button>
      </div>
      <ul>{render(tree, 0)}</ul>
    </nav>
  );
}
