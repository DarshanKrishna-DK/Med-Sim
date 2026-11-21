import { store } from '../../game/store';
import { BrandMark, enterHospital, goToLandingSection } from './chrome';
import { FooterScene } from './pixel/FooterScene';

const REPO = 'https://github.com/DarshanKrishna-DK/MedSim';
const DEMO = 'https://medsim-0cla.onrender.com';

/** Landing footer: brand + links over the pixel night street, with the
 *  credits line sitting on the road at the very bottom. */
export function SiteFooter() {
  return (
    <footer className="site-footer night">
      <div className="wrap footer-top">
        <div className="footer-brand">
          <span className="footer-lockup">
            <BrandMark size={40} />
            <span className="footer-word">MedSim</span>
          </span>
          <p className="footer-line">
            See you on the <em>night shift</em>.
          </p>
          <p className="footer-tag">The Voice-First Clinical Simulator. Practise outpatient consultations out loud, on a night shift that never ends.</p>
        </div>

        <nav className="footer-nav" aria-label="Footer">
          <div>
            <p className="kicker">Play</p>
            <ul>
              <li>
                <button type="button" className="footer-link" onClick={enterHospital}>
                  Enter the hospital
                </button>
              </li>
              <li>
                <button type="button" className="footer-link" onClick={() => store.setScreen('library')}>
                  Case library
                </button>
              </li>
              <li>
                <button type="button" className="footer-link" onClick={() => goToLandingSection('how')}>
                  How it works
                </button>
              </li>
            </ul>
          </div>
          <div>
            <p className="kicker">Project</p>
            <ul>
              <li>
                <a className="footer-link" href={REPO} target="_blank" rel="noreferrer">
                  GitHub
                </a>
              </li>
              <li>
                <a className="footer-link" href={DEMO} target="_blank" rel="noreferrer">
                  Live demo
                </a>
              </li>
              <li>
                <a className="footer-link" href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
                  MIT license
                </a>
              </li>
            </ul>
          </div>
        </nav>
      </div>

      <FooterScene />

      <div className="footer-base">
        <div className="wrap footer-base-inner">
          <p>
            Built for Build with Agora Bengaluru 2026 with Agora Conversational AI, Murf Falcon and Sarvam.
          </p>
          <p className="footer-small">Synthetic cases, for training only. Not clinical advice.</p>
        </div>
      </div>
    </footer>
  );
}
