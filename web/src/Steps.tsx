// Where the person is in a flow. A real sequence, so numbered.
import { useT } from './i18n';

export function Steps({ current, flow = 'client' }: { current: number; flow?: 'client' | 'create' }) {
  const t = useT().steps;
  const labels = t[flow];
  return (
    <ol className="steps" aria-label={t.label}>
      {labels.map((name, i) => (
        <li
          key={name}
          className={i < current ? 'done' : i === current ? 'now' : undefined}
          aria-current={i === current ? 'step' : undefined}
        >
          <span className="step-num" aria-hidden="true">
            {i < current ? '✓' : i + 1}
          </span>
          {name}
        </li>
      ))}
    </ol>
  );
}
