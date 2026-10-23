import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { UserGroup } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Section, Tabs, Tick, Toggle } from '../../components/ui';
import { hostById } from '../../engine/world';
import { blankUser, deleteGroup, deleteUser, saveGroup, saveUser, saveUserSettings, toForm, validateGroup, validateUser, type UserForm } from '../../services/userService';
import { hashPasswordSecure } from '../../lib/hash';

type Tab = 'users' | 'groups';

export function LocalUsersPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [tab, setTab] = useState<Tab>('users');
  const [edit, setEdit] = useState<{ f: UserForm; originalId: string | null } | null>(null);
  const [gedit, setGedit] = useState<{ g: UserGroup; original: string | null } | null>(null);
  const [del, setDel] = useState<{ kind: 'user' | 'group'; id: string } | null>(null);
  return (
    <div className="tw-page">
      <Tabs<Tab> tabs={[{ id: 'users', label: 'Local Users' }, { id: 'groups', label: 'Local Groups' }]} value={tab} onChange={setTab} />
      <div className="tw-toolbar">
        <span className="muted">Lab users only. Use practice passwords.</span><span className="spacer" />
        {tab === 'users'
          ? <button className="tw-tool" data-guide="add-user" onClick={() => setEdit({ f: blankUser(), originalId: null })}><Plus size={15} /> Add User</button>
          : <button className="tw-tool" data-guide="add-ugroup" onClick={() => setGedit({ g: { name: '', builtIn: false, comment: '' }, original: null })}><Plus size={15} /> Add Group</button>}
      </div>
      <div className="tw-table-wrap">
        {tab === 'users' ? (
          <table className="tw-table" aria-label="Local users">
            <thead><tr><th>#</th><th>Name</th><th>Groups</th><th>One-time password</th><th>Comment</th><th>Configure</th></tr></thead>
            <tbody>
              {config.users.local.map((u, n) => (
                <tr key={u.id} data-guide={`user:${u.name}`}>
                  <td>{n + 1}</td><td><b>{u.name}</b></td><td>{u.groups.join(', ')}</td><td><Tick on={u.otp} /></td><td>{u.comment}</td>
                  <td>
                    <button className="tw-rowbtn" aria-label={`Edit ${u.name}`} data-guide={`edit-user:${u.name}`} onClick={() => setEdit({ f: toForm(u), originalId: u.id })}><Pencil size={15} /></button>
                    <button className="tw-rowbtn" aria-label={`Delete ${u.name}`} onClick={() => setDel({ kind: 'user', id: u.id })}><Trash2 size={15} /></button>
                  </td>
                </tr>
              ))}
              {!config.users.local.length ? <tr><td colSpan={6} className="muted">No local users.</td></tr> : null}
            </tbody>
          </table>
        ) : (
          <table className="tw-table" aria-label="Local groups">
            <thead><tr><th>#</th><th>Name</th><th>Members</th><th>Class</th><th>Configure</th></tr></thead>
            <tbody>
              {config.users.groups.map((g, n) => (
                <tr key={g.name} data-guide={`ugroup:${g.name}`}>
                  <td>{n + 1}</td><td><b>{g.name}</b></td><td>{g.name === 'Everyone' ? 'all users' : config.users.local.filter((u) => u.groups.includes(g.name)).map((u) => u.name).join(', ') || '—'}</td><td>{g.builtIn ? 'Default' : 'Custom'}</td>
                  <td>{g.name === 'Everyone' ? <span className="muted">—</span> : <>
                    <button className="tw-rowbtn" aria-label={`Edit ${g.name}`} data-guide={`edit-ugroup:${g.name}`} onClick={() => setGedit({ g: { ...g }, original: g.name })}><Pencil size={15} /></button>
                    {!g.builtIn ? <button className="tw-rowbtn" aria-label={`Delete ${g.name}`} onClick={() => setDel({ kind: 'group', id: g.name })}><Trash2 size={15} /></button> : null}
                  </>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {edit && <UserDialog initial={edit.f} originalId={edit.originalId} onClose={() => setEdit(null)} onSave={async (f) => { const r = saveUser(config, f, edit.originalId, f.password ? await hashPasswordSecure(f.password) : ''); commit(r.next, r.audit); toast(<>User <b>{f.name}</b> saved.</>); setEdit(null); }} />}
      {gedit && <GroupDialog initial={gedit.g} original={gedit.original} onClose={() => setGedit(null)} onSave={(g, m) => { const r = saveGroup(config, g, gedit.original, m); commit(r.next, r.audit); toast(<>Group <b>{g.name}</b> saved.</>); setGedit(null); }} />}
      {del && <Confirm title="Delete" danger confirmLabel="Delete" message="Delete this entry?" onCancel={() => setDel(null)} onConfirm={() => {
        const r = del.kind === 'user' ? deleteUser(config, del.id) : deleteGroup(config, del.id); setDel(null);
        const err = (r as { error?: string }).error; if (err) toast(err, "bad"); else commit(r.next, r.audit);
      }} />}
    </div>
  );
}

function UserDialog({ initial, originalId, onClose, onSave }: { initial: UserForm; originalId: string | null; onClose: () => void; onSave: (f: UserForm) => void }) {
  const { config } = useStore();
  const [f, setF] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('user', { name: f.name, groups: f.groups, otp: f.otp, pwSet: !!f.password, pwMatch: f.password === f.confirm });
  const errors = validateUser(config, f, originalId);
  const e = tried ? errors : {};
  return (
    <Dialog title={originalId ? `Edit User - ${initial.name}` : 'Add User'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="user-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(f); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="us-name" error={e.name}><input id="us-name" className={`tw-input${e.name ? ' invalid' : ''}`} value={f.name} disabled={!!originalId} onChange={(ev) => setF({ ...f, name: ev.target.value.trim() })} /></Row>
        <Row label={originalId ? 'New Password (optional)' : 'Password'} htmlFor="us-pw" error={e.password}><input id="us-pw" type="password" autoComplete="new-password" className={`tw-input wide${e.password ? ' invalid' : ''}`} value={f.password} onChange={(ev) => setF({ ...f, password: ev.target.value })} /></Row>
        <Row label="Confirm Password" htmlFor="us-pw2" error={e.confirm}><input id="us-pw2" type="password" autoComplete="new-password" className={`tw-input wide${e.confirm ? ' invalid' : ''}`} value={f.confirm} onChange={(ev) => setF({ ...f, confirm: ev.target.value })} /></Row>
        <Row label="Member of" error={e.groups}>
          <div className="tw-checks" id="us-groups" style={{ flexWrap: 'wrap' }}>
            {config.users.groups.map((g) => (
              <label key={g.name}><input type="checkbox" data-guide={`us-group:${g.name}`} disabled={g.name === 'Everyone'} checked={f.groups.includes(g.name) || g.name === 'Everyone'} onChange={(ev) => setF({ ...f, groups: ev.target.checked ? [...f.groups, g.name] : f.groups.filter((x) => x !== g.name) })} /> {g.name}</label>
            ))}
          </div>
        </Row>
        <Row label="Require one-time password (TOTP)" hint="The lab authenticator code is shown in Lab Tools › Lab Controls."><Toggle id="us-otp" checked={f.otp} onChange={(v) => setF({ ...f, otp: v })} label="Require one-time password" /></Row>
        <Row label="Comment" htmlFor="us-comment"><input id="us-comment" className="tw-input wide" value={f.comment} onChange={(ev) => setF({ ...f, comment: ev.target.value })} /></Row>
      </div>
      <Note kind="warn">Lab only: use a practice password. It is hashed in your browser and never sent anywhere.</Note>
    </Dialog>
  );
}

function GroupDialog({ initial, original, onClose, onSave }: { initial: UserGroup; original: string | null; onClose: () => void; onSave: (g: UserGroup, members: string[]) => void }) {
  const { config } = useStore();
  const [g, setG] = useState(initial);
  const [members, setMembers] = useState<string[]>(() => config.users.local.filter((u) => original && u.groups.includes(original)).map((u) => u.name));
  const [tried, setTried] = useState(false);
  useDraft('ugroup', { ...g, members });
  const errors = validateGroup(config, g, original);
  const e = tried ? errors : {};
  return (
    <Dialog title={original ? `Edit Group - ${original}` : 'Add Group'} size="sm" onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="ugroup-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(g, members); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="ug-name" error={e.name}><input id="ug-name" className={`tw-input${e.name ? ' invalid' : ''}`} value={g.name} disabled={g.builtIn} onChange={(ev) => setG({ ...g, name: ev.target.value })} /></Row>
        <Row label="Members">
          <div className="tw-checks" id="ug-members" style={{ flexWrap: 'wrap' }}>
            {config.users.local.length ? config.users.local.map((u) => <label key={u.id}><input type="checkbox" checked={members.includes(u.name)} onChange={(ev) => setMembers(ev.target.checked ? [...members, u.name] : members.filter((x) => x !== u.name))} /> {u.name}</label>) : <span className="muted">No users yet — you can also pick groups when adding a user.</span>}
          </div>
        </Row>
        <Row label="Comment" htmlFor="ug-comment"><input id="ug-comment" className="tw-input wide" value={g.comment} onChange={(ev) => setG({ ...g, comment: ev.target.value })} /></Row>
      </div>
    </Dialog>
  );
}

export function UserSettingsPage() {
  const { config, commit } = useStore();
  const set = (p: Parameters<typeof saveUserSettings>[1]) => { const r = saveUserSettings(config, p); commit(r.next, r.audit); };
  const x0 = config.interfaces.find((i) => i.name === 'X0');
  return (
    <div className="tw-page">
      <Section title="User Authentication Settings">
        <div className="tw-form">
          <Row label="User authentication method"><span className="val">Local Users</span></Row>
          <Row label="Redirect unauthenticated users to the login page" hint="Applies when an access rule has Users Included other than All."><Toggle checked={config.users.redirectToLogin} onChange={(v) => set({ redirectToLogin: v })} label="Redirect to login" /></Row>
          <Row label="Inactivity timeout (minutes)" htmlFor="us-idle"><input id="us-idle" className="tw-input" style={{ width: 80 }} value={String(config.users.inactivityMin)} onChange={(e) => set({ inactivityMin: Number(e.target.value.replace(/\D/g, '')) || 1 })} /></Row>
          <Row label="User login on X0"><span className="val">{x0?.userLogin.https ? 'HTTPS enabled' : 'disabled — enable “User Login HTTPS” on X0'}</span></Row>
        </div>
      </Section>
    </div>
  );
}

export function UserStatusPage() {
  const { lab } = useStore();
  return (
    <div className="tw-page">
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Active user sessions">
          <thead><tr><th>User</th><th>Host</th><th>Logged in</th><th>Type</th></tr></thead>
          <tbody>
            {lab.authSessions.map((a) => <tr key={a.host}><td><b>{a.user}</b></td><td>{hostById(a.host)?.name}</td><td>{new Date(a.since).toLocaleTimeString()}</td><td>Web login</td></tr>)}
            {lab.remoteUserConnected ? <tr><td><b>NetExtender</b></td><td>REMOTE-LAPTOP</td><td>—</td><td>SSL VPN</td></tr> : null}
            {!lab.authSessions.length && !lab.remoteUserConnected ? <tr><td colSpan={4} className="muted">No users logged in. Use Lab Tools › Lab Controls › User login to log a user in on a LAN host.</td></tr> : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
