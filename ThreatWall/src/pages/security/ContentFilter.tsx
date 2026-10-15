import { useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import type { CfsProfile, CfsRule } from '../../state/types';
import { useStore } from '../../state/store';
import { useDraft } from '../../state/ui';
import { useToast } from '../../components/Toast';
import { Confirm, Dialog, Note, Row, Section, Toggle } from '../../components/ui';
import { ZoneSelect } from '../../components/pickers';
import { CFS_CATEGORIES } from '../../engine/world';
import {
  blankCfsRule, blankProfile, deleteCfsRule, deleteProfile, licensed, saveCfsRule, saveCfsSettings, saveProfile, validateCfsRule, validateProfile,
} from '../../services/securityService';

export function LicenseNote({ id, name }: { id: string; name: string }) {
  const { config } = useStore();
  return licensed(config, id) ? null : <Note kind="bad">{name} is not licensed. Settings can be saved but nothing is enforced until the appliance is registered (task 0.5).</Note>;
}

/* ---------- POLICY › Security Services › Content Filter ---------- */
export function CfsSettingsPage() {
  const { config, commit } = useStore();
  const c = config.security.cfs;
  const set = (p: Parameters<typeof saveCfsSettings>[1]) => { const r = saveCfsSettings(config, p); commit(r.next, r.audit); };
  return (
    <div className="tw-page">
      <LicenseNote id="cfs" name="Content Filtering Service" />
      <Section title="Content Filter Settings">
        <div className="tw-form">
          <Row label="Enable Content Filtering Service" hint="Global switch. Policies (POLICY › Content Filter Rules) choose who gets which profile."><Toggle id="cfs-enable" checked={c.enabled} onChange={(v) => set({ enabled: v })} label="Enable content filtering" /></Row>
          <Row label="Block if CFS server is unavailable" hint="Fail closed. Safer, but an outage of the rating service blocks browsing."><Toggle checked={c.blockIfUnavailable} onChange={(v) => set({ blockIfUnavailable: v })} label="Block if server unavailable" /></Row>
          <Row label="Exclude administrator"><Toggle checked={c.excludeAdmin} onChange={(v) => set({ excludeAdmin: v })} label="Exclude administrator" /></Row>
          <Row label="Profiles / policies"><span className="val">{c.profiles.length} profile(s), {c.rules.length} polic{c.rules.length === 1 ? 'y' : 'ies'}</span></Row>
        </div>
      </Section>
    </div>
  );
}

/* ---------- OBJECT › Profile Objects › Content Filter ---------- */
export function CfsProfilesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<{ p: CfsProfile; originalId: string | null } | null>(null);
  const [del, setDel] = useState<string | null>(null);
  return (
    <div className="tw-page">
      <div className="tw-toolbar"><span className="muted">A profile says which categories are blocked and which sites are always allowed.</span><span className="spacer" />
        <button className="tw-tool" data-guide="add-cfsprofile" onClick={() => setEdit({ p: blankProfile(), originalId: null })}><Plus size={15} /> Add</button></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Content filter profiles">
          <thead><tr><th>#</th><th>Name</th><th>Blocked Categories</th><th>Allowed Domains</th><th>Configure</th></tr></thead>
          <tbody>
            {config.security.cfs.profiles.map((p, n) => (
              <tr key={p.id} data-guide={`cfsprofile:${p.name}`}>
                <td>{n + 1}</td><td><b>{p.name}</b></td><td style={{ whiteSpace: 'normal' }}>{p.blocked.join(', ') || 'none'}</td><td>{p.allowList.join(', ') || '—'}</td>
                <td>
                  <button className="tw-rowbtn" aria-label={`Edit ${p.name}`} onClick={() => setEdit({ p: { ...p }, originalId: p.id })}><Pencil size={15} /></button>
                  {p.id !== 'cfs-default' ? <button className="tw-rowbtn" aria-label={`Delete ${p.name}`} onClick={() => setDel(p.id)}><Trash2 size={15} /></button> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ProfileDialog initial={edit.p} originalId={edit.originalId} onClose={() => setEdit(null)} onSave={(p) => { const r = saveProfile(config, p, edit.originalId); commit(r.next, r.audit); toast(<>Profile <b>{p.name}</b> saved.</>); setEdit(null); }} />}
      {del && <Confirm title="Delete profile" danger confirmLabel="Delete" message="Delete this profile?" onCancel={() => setDel(null)} onConfirm={() => { const r = deleteProfile(config, del); setDel(null); if (r.error) toast(r.error, 'bad'); else commit(r.next, r.audit); }} />}
    </div>
  );
}

function ProfileDialog({ initial, originalId, onClose, onSave }: { initial: CfsProfile; originalId: string | null; onClose: () => void; onSave: (p: CfsProfile) => void }) {
  const { config } = useStore();
  const [p, setP] = useState(initial);
  const [allow, setAllow] = useState(initial.allowList.join('\n'));
  const [tried, setTried] = useState(false);
  const cur = { ...p, allowList: allow.split(/[\n,]/).map((x) => x.trim()).filter(Boolean) };
  useDraft('cfsprofile', cur);
  const errors = validateProfile(config, cur, originalId);
  const e = tried ? errors : {};
  return (
    <Dialog title={originalId ? `Edit Profile - ${initial.name}` : 'Add Content Filter Profile'} onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="cfsprofile-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(cur); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="cp-name" error={e.name}><input id="cp-name" className={`tw-input wide${e.name ? ' invalid' : ''}`} value={p.name} onChange={(ev) => setP({ ...p, name: ev.target.value })} /></Row>
      </div>
      <h3 className="tw-section-title">Blocked categories</h3>
      <div className="tw-catgrid" id="cp-cats">
        {CFS_CATEGORIES.map((c) => (
          <label key={c}><input type="checkbox" data-guide={`cat:${c}`} checked={p.blocked.includes(c)} onChange={(ev) => setP({ ...p, blocked: ev.target.checked ? [...p.blocked, c] : p.blocked.filter((x) => x !== c) })} /> {c}</label>
        ))}
      </div>
      <div className="tw-form">
        <Row label="Always allow (one domain per line)" htmlFor="cp-allow" error={e.allowList}><textarea id="cp-allow" className="tw-textarea" rows={3} value={allow} onChange={(ev) => setAllow(ev.target.value)} placeholder="video.example" /></Row>
      </div>
    </Dialog>
  );
}

/* ---------- POLICY › Rules and Policies › Content Filter Rules ---------- */
export function CfsRulesPage() {
  const { config, commit } = useStore();
  const toast = useToast();
  const [edit, setEdit] = useState<{ r: CfsRule; originalId: string | null } | null>(null);
  return (
    <div className="tw-page">
      <div className="tw-toolbar"><span className="muted">The first enabled policy whose source zone and users match decides the profile.</span><span className="spacer" />
        <button className="tw-tool" data-guide="add-cfsrule" onClick={() => setEdit({ r: { ...blankCfsRule(), profile: config.security.cfs.profiles[0]?.name ?? '' }, originalId: null })}><Plus size={15} /> Add</button></div>
      <div className="tw-table-wrap">
        <table className="tw-table" aria-label="Content filter rules">
          <thead><tr><th>#</th><th>Name</th><th>Source Zone</th><th>Destination Zone</th><th>Users</th><th>Profile</th><th>Hits</th><th>Enable</th><th>Configure</th></tr></thead>
          <tbody>
            {config.security.cfs.rules.map((r, n) => (
              <tr key={r.id} className={r.enabled ? '' : 'disabled'} data-guide={`cfsrule:${r.name}`}>
                <td>{n + 1}</td><td><b>{r.name}</b></td><td>{r.srcZone}</td><td>{r.dstZone}</td><td>{r.users}</td><td>{r.profile}</td><td className="mono">{r.hits}</td>
                <td><Toggle checked={r.enabled} label={`Enable ${r.name}`} onChange={(v) => { const x = saveCfsRule(config, { ...r, enabled: v }, r.id); commit(x.next, x.audit); }} /></td>
                <td>
                  <button className="tw-rowbtn" aria-label={`Edit ${r.name}`} onClick={() => setEdit({ r: { ...r }, originalId: r.id })}><Pencil size={15} /></button>
                  <button className="tw-rowbtn" aria-label={`Delete ${r.name}`} onClick={() => { const x = deleteCfsRule(config, r.id); commit(x.next, x.audit); }}><Trash2 size={15} /></button>
                </td>
              </tr>
            ))}
            {!config.security.cfs.rules.length ? <tr><td colSpan={9} className="muted">No content filter policy — no traffic is filtered even if CFS is enabled.</td></tr> : null}
          </tbody>
        </table>
      </div>
      {edit && <CfsRuleDialog initial={edit.r} originalId={edit.originalId} onClose={() => setEdit(null)} onSave={(r) => { const x = saveCfsRule(config, r, edit.originalId); commit(x.next, x.audit); toast(<>Policy <b>{r.name}</b> saved.</>); setEdit(null); }} />}
    </div>
  );
}

function CfsRuleDialog({ initial, originalId, onClose, onSave }: { initial: CfsRule; originalId: string | null; onClose: () => void; onSave: (r: CfsRule) => void }) {
  const { config } = useStore();
  const [r, setR] = useState(initial);
  const [tried, setTried] = useState(false);
  useDraft('cfsrule', r);
  const errors = validateCfsRule(config, r, originalId);
  const e = tried ? errors : {};
  return (
    <Dialog title={originalId ? `Edit Policy - ${initial.name}` : 'Add Content Filter Policy'} size="sm" onClose={onClose} footer={<>
      <button className="tw-btn" onClick={onClose}>Cancel</button>
      <button className="tw-btn tw-btn-primary" data-guide="cfsrule-save" onClick={() => { setTried(true); if (!Object.keys(errors).length) onSave(r); }}>Save</button>
    </>}>
      <div className="tw-form" style={{ paddingTop: 12 }}>
        <Row label="Name" htmlFor="cr-name" error={e.name}><input id="cr-name" className={`tw-input${e.name ? ' invalid' : ''}`} value={r.name} onChange={(ev) => setR({ ...r, name: ev.target.value })} /></Row>
        <Row label="Source Zone" htmlFor="cr-src" error={e.srcZone}><ZoneSelect cfg={config} id="cr-src" value={r.srcZone} onChange={(v) => setR({ ...r, srcZone: v })} all="Any" /></Row>
        <Row label="Destination Zone"><span className="val">WAN</span></Row>
        <Row label="Users" htmlFor="cr-users">
          <select id="cr-users" className="tw-select" value={r.users} onChange={(ev) => setR({ ...r, users: ev.target.value })}>
            <option value="All">All</option>{config.users.groups.map((g) => <option key={g.name}>{g.name}</option>)}
          </select>
        </Row>
        <Row label="Profile" htmlFor="cr-profile" error={e.profile}>
          <select id="cr-profile" className={`tw-select${e.profile ? ' invalid' : ''}`} value={r.profile} onChange={(ev) => setR({ ...r, profile: ev.target.value })}>
            <option value="">— select —</option>{config.security.cfs.profiles.map((p) => <option key={p.id}>{p.name}</option>)}
          </select>
        </Row>
        <Row label="Enable"><Toggle checked={r.enabled} onChange={(v) => setR({ ...r, enabled: v })} label="Enable policy" /></Row>
      </div>
    </Dialog>
  );
}
