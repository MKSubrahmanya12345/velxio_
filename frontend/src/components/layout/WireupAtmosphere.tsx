import React from 'react';

type Tone = 'accent' | 'quiet' | 'good' | 'warn';

const Metric = ({ label, value, tone = 'quiet' }: { label: string; value: string; tone?: Tone }) => (
  <span className={`wireup-hud-metric wireup-hud-metric--${tone}`}>
    <span className="wireup-hud-metric__label">{label}</span>
    <strong>{value}</strong>
  </span>
);

const CornerMark = ({ className = '' }: { className?: string }) => (
  <span className={`wireup-hud-corner ${className}`} aria-hidden="true">
    <i />
    <i />
    <i />
  </span>
);

export const WireupAtmosphere: React.FC = () => {
  return (
    <div className="wireup-atmosphere" aria-hidden="true">
      <div className="wireup-atmosphere__grain" />
      <div className="wireup-atmosphere__scanline" />
      <div className="wireup-atmosphere__halo wireup-atmosphere__halo--a" />
      <div className="wireup-atmosphere__halo wireup-atmosphere__halo--b" />
      <div className="wireup-atmosphere__orbit wireup-atmosphere__orbit--a" />
      <div className="wireup-atmosphere__orbit wireup-atmosphere__orbit--b" />
      <CornerMark className="wireup-atmosphere__corner--tl" />
      <CornerMark className="wireup-atmosphere__corner--tr" />
      <CornerMark className="wireup-atmosphere__corner--bl" />
      <CornerMark className="wireup-atmosphere__corner--br" />

      <div className="wireup-hud wireup-hud--top">
        <div className="wireup-hud__left">
          <span className="wireup-hud-brand">WIREUP / WORKBENCH</span>
          <span className="wireup-hud-separator" />
          <span className="wireup-hud-mode">LOCAL ENGINE</span>
        </div>
        <div className="wireup-hud__center">
          <span className="wireup-hud-live-dot" />
          <span>WORKSPACE LINKED</span>
        </div>
        <div className="wireup-hud__right">
          <Metric label="LAT" value="LOCAL" />
          <Metric label="CORE" value="READY" tone="good" />
        </div>
      </div>

      <div className="wireup-hud wireup-hud--left">
        <div className="wireup-hud-vertical">BUILD / SIMULATE / INSPECT</div>
      </div>

      <div className="wireup-hud wireup-hud--right">
        <div className="wireup-hud-vertical wireup-hud-vertical--reverse">HARDWARE WORKSPACE</div>
      </div>

      <div className="wireup-hud wireup-hud--bottom">
        <div className="wireup-hud__left">
          <Metric label="CTRL" value="⌘K" tone="quiet" />
          <Metric label="RUN" value="⌘↵" tone="accent" />
          <Metric label="RESET" value="ESC" />
        </div>
        <div className="wireup-hud__center">
          <div className="wireup-hud-wave">
            <span /><span /><span /><span /><span /><span /><span />
          </div>
          <span>REAL-TIME WORKBENCH</span>
        </div>
        <div className="wireup-hud__right">
          <span className="wireup-hud-buildline">
            <i />
            <span>AGENT RUNTIME</span>
          </span>
        </div>
      </div>

      <div className="wireup-hud-radar">
        <div className="wireup-radar-ring wireup-radar-ring--1" />
        <div className="wireup-radar-ring wireup-radar-ring--2" />
        <div className="wireup-radar-sweep" />
        <span className="wireup-radar-center" />
      </div>

      <div className="wireup-data-stream wireup-data-stream--a">
        {Array.from({ length: 18 }, (_, i) => (
          <span key={i}>{['01', '7F', 'A2', 'C4', '00', 'FF'][i % 6]}</span>
        ))}
      </div>

      <div className="wireup-data-stream wireup-data-stream--b">
        {Array.from({ length: 14 }, (_, i) => (
          <span key={i}>{['RX', 'TX', 'CLK', 'VCC', 'GND'][i % 5]}</span>
        ))}
      </div>
    </div>
  );
};
