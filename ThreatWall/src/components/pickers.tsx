/** Object selectors shared by every rule/policy dialog. They always list what exists in the saved configuration. */
import type { FirewallConfig } from '../state/types';
import { builtInAddresses, builtInGroups } from '../engine/objects';

interface Base { id: string; value: string; onChange: (v: string) => void; invalid?: boolean; disabled?: boolean; guide?: string }

export function AddressSelect({ cfg, id, value, onChange, invalid, disabled, guide, any = 'Any', extra = [] }: Base & { cfg: FirewallConfig; any?: string | null; extra?: string[] }) {
  const custom = cfg.addresses.map((a) => a.name);
  const groups = cfg.addressGroups.map((g) => g.name);
  const known = new Set([...(any ? [any] : []), ...extra, ...custom, ...groups, ...builtInGroups(cfg).map((g) => g.name), ...builtInAddresses(cfg).map((a) => a.name)]);
  return (
    <select id={id} data-guide={guide} className={`tw-select${invalid ? ' invalid' : ''}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {!known.has(value) ? <option value={value}>{value || '— select —'}</option> : null}
      {any ? <option value={any}>{any}</option> : null}
      {extra.map((x) => <option key={x} value={x}>{x}</option>)}
      {custom.length ? <optgroup label="Address objects">{custom.map((n) => <option key={n}>{n}</option>)}</optgroup> : null}
      {groups.length ? <optgroup label="Address groups">{groups.map((n) => <option key={n}>{n}</option>)}</optgroup> : null}
      <optgroup label="Default groups">{builtInGroups(cfg).map((g) => <option key={g.name}>{g.name}</option>)}</optgroup>
      <optgroup label="Default objects">{builtInAddresses(cfg).map((a) => <option key={a.name}>{a.name}</option>)}</optgroup>
    </select>
  );
}

export function ServiceSelect({ cfg, id, value, onChange, invalid, disabled, guide, any = 'Any' }: Base & { cfg: FirewallConfig; any?: string }) {
  const groups = cfg.serviceGroups.map((g) => g.name);
  const objs = cfg.services.map((x) => x.name);
  const known = new Set([any, ...groups, ...objs]);
  return (
    <select id={id} data-guide={guide} className={`tw-select${invalid ? ' invalid' : ''}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {!known.has(value) ? <option value={value}>{value || '— select —'}</option> : null}
      <option value={any}>{any}</option>
      <optgroup label="Service groups">{groups.map((n) => <option key={n}>{n}</option>)}</optgroup>
      <optgroup label="Service objects">{objs.map((n) => <option key={n}>{n}</option>)}</optgroup>
    </select>
  );
}

export function ZoneSelect({ cfg, id, value, onChange, invalid, disabled, guide, all }: Base & { cfg: FirewallConfig; all?: string }) {
  return (
    <select id={id} data-guide={guide} className={`tw-select${invalid ? ' invalid' : ''}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {all ? <option value={all}>{all}</option> : null}
      {cfg.zones.map((z) => <option key={z.name}>{z.name}</option>)}
    </select>
  );
}

export function IfaceSelect({ cfg, id, value, onChange, invalid, disabled, guide, any, onlyAddressed }: Base & { cfg: FirewallConfig; any?: string; onlyAddressed?: boolean }) {
  const list = cfg.interfaces.filter((i) => !onlyAddressed || (i.zone && i.mode === 'static'));
  return (
    <select id={id} data-guide={guide} className={`tw-select${invalid ? ' invalid' : ''}`} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      {any ? <option value={any}>{any}</option> : null}
      {!list.some((i) => i.name === value) && value !== any ? <option value={value}>{value || '— select —'}</option> : null}
      {list.map((i) => <option key={i.name} value={i.name}>{i.name}{i.zone ? ` (${i.zone})` : ''}</option>)}
    </select>
  );
}

export function ScheduleSelect({ cfg, id, value, onChange, invalid, guide }: Base & { cfg: FirewallConfig }) {
  return (
    <select id={id} data-guide={guide} className={`tw-select${invalid ? ' invalid' : ''}`} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="Always">Always</option>
      {cfg.schedules.map((s) => <option key={s.name}>{s.name}</option>)}
    </select>
  );
}

export function GroupSelect({ cfg, id, value, onChange, any, guide }: Base & { cfg: FirewallConfig; any: string }) {
  return (
    <select id={id} data-guide={guide} className="tw-select" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value={any}>{any}</option>
      {cfg.users.groups.map((g) => <option key={g.name}>{g.name}</option>)}
    </select>
  );
}
