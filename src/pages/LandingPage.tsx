import { useNavigate } from "react-router-dom";
import { KnoveraMark } from "../components/KnoveraMark";

/**
 * Phase 4A visual-polish pass — Knovera's landing page ("/"). Standalone
 * entry screen: a minimal top bar (wordmark only, no nav — nothing to
 * navigate to before Enter) and a left-aligned editorial hero with an
 * abstract SVG knowledge-graph visual on the right. Pure presentational
 * component: no data fetching, no props, no backend calls.
 */
export function LandingPage() {
  const navigate = useNavigate();

  return (
    <div className="knovera-landing">
      <div className="knovera-landing-topbar">
        <span className="kv-wordmark">
          <KnoveraMark size={20} />
          <span className="kv-wordmark-text">Knovera</span>
        </span>
      </div>

      <div className="knovera-landing-body">
        <div className="knovera-landing-grid">
          <div>
            <p className="knovera-eyebrow">The Knowledge Synthesis Platform</p>
            <h1 className="knovera-landing-hero">
              Watch less.
              <br />
              Know more.
            </h1>
            <p className="knovera-landing-support">
              <strong>~100,000 hours</strong> of new video are created every hour. Knovera turns the information you
              could never watch into knowledge you can actually use.
            </p>
            <div className="knovera-landing-cta-row">
              <button type="button" className="knovera-cta" onClick={() => navigate("/projects")}>
                Enter Knovera
                <span className="knovera-cta-arrow" aria-hidden="true">
                  →
                </span>
              </button>
              <p className="knovera-landing-microcopy">Sources → Analysis → Knowledge → Intelligence</p>
            </div>
          </div>

          <KnowledgeGraphVisual />
        </div>
      </div>
    </div>
  );
}

/**
 * Abstract knowledge-graph / constellation visual — CSS/SVG only, no image
 * assets, no charting library. A loose scatter of nodes converges toward
 * one bright accent node (the "synthesis" point); three edges pulse slowly
 * and subtly to suggest ongoing connection-forming rather than a static
 * diagram. Respects prefers-reduced-motion (see index.css).
 */
function KnowledgeGraphVisual() {
  return (
    <div className="knovera-graph-wrap" aria-hidden="true">
      <svg viewBox="0 0 400 400" className="knovera-graph-svg">
        <line x1="70" y1="90" x2="200" y2="200" className="knovera-graph-edge" />
        <line x1="330" y1="70" x2="200" y2="200" className="knovera-graph-edge" />
        <line x1="60" y1="260" x2="200" y2="200" className="knovera-graph-edge" />
        <line x1="340" y1="290" x2="200" y2="200" className="knovera-graph-edge" />
        <line x1="200" y1="60" x2="200" y2="200" className="knovera-graph-edge-active" />
        <line x1="120" y1="330" x2="200" y2="200" className="knovera-graph-edge-active" />
        <line x1="300" y1="180" x2="200" y2="200" className="knovera-graph-edge-active" />
        <line x1="70" y1="90" x2="200" y2="60" className="knovera-graph-edge" />
        <line x1="330" y1="70" x2="300" y2="180" className="knovera-graph-edge" />
        <line x1="60" y1="260" x2="120" y2="330" className="knovera-graph-edge" />

        <circle cx="70" cy="90" r="4" className="knovera-graph-node" />
        <circle cx="330" cy="70" r="3.5" className="knovera-graph-node" />
        <circle cx="60" cy="260" r="4" className="knovera-graph-node" />
        <circle cx="340" cy="290" r="3" className="knovera-graph-node" />
        <circle cx="200" cy="60" r="5" className="knovera-graph-node knovera-graph-pulse" />
        <circle cx="120" cy="330" r="4.5" className="knovera-graph-node knovera-graph-pulse knovera-graph-pulse-delay" />
        <circle cx="300" cy="180" r="4" className="knovera-graph-node knovera-graph-pulse knovera-graph-pulse-delay-2" />

        <circle cx="200" cy="200" r="9" className="knovera-graph-node-core" />
      </svg>
    </div>
  );
}
