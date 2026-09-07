import { useNavigate } from "react-router-dom";

/**
 * Phase 4A — Knovera's landing page ("/"). Standalone entry screen, no app
 * chrome (no top nav) — the user hasn't "entered" the product yet. Pure
 * presentational component: no data fetching, no props, no backend calls.
 */
export function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="knovera-landing">
      <div className="knovera-landing-inner">
        <div className="knovera-landing-mark">Knovera</div>
        <p className="knovera-landing-tagline">Watch less. Know more.</p>
        <h1 className="knovera-landing-hero">
          ~100,000 hours of new video are created every hour.
          <br />
          No one can watch it all.
          <br />
          Knovera turns the universe of video into structured, connected knowledge.
        </h1>
        <p className="knovera-landing-support">Turn endless video into knowledge you can actually use.</p>
        <button type="button" className="knovera-cta" onClick={() => navigate("/projects")}>
          Enter Knovera
        </button>
      </div>
    </div>
  );
}
