import { useStore } from '../../state/store';
import { Note, Row, Section } from '../../components/ui';
import { TIMEZONES } from '../../services/setupService';
import { labNow, localTime } from '../../engine/objects';

export function TimePage() {
  const { state, config, commit } = useStore();
  const tz = config.system.timezone;
  return (
    <div className="tw-page">
      <Section title="System Time">
        <div className="tw-form">
          <Row label="Time (lab clock)"><span className="val mono">{localTime(labNow(state), tz).label}</span></Row>
          <Row label="Time Zone" htmlFor="tm-tz">
            <select id="tm-tz" className="tw-select" value={tz} onChange={(e) => commit({ ...config, system: { ...config.system, timezone: e.target.value } }, [{ category: 'System', action: 'Time zone changed', detail: `${tz} → ${e.target.value}` }])}>
              {TIMEZONES.map((z) => <option key={z}>{z}</option>)}
            </select>
          </Row>
          <Row label="Set time automatically using NTP"><span className="val">On · time.lab.example (simulated)</span></Row>
        </div>
      </Section>
      <Note kind="info">Schedules (task 2.1), logs and certificates all depend on correct time. The lab clock can be moved in Lab Tools › Lab Controls.</Note>
    </div>
  );
}
