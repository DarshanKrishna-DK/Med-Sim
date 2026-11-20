import { useEffect, useState } from 'react';

// Hindi (Devanagari) names for the department signage. Rendered through a
// 2D canvas so the browser shapes conjuncts and matras correctly.

const HI: Record<string, string> = {
  'internal-medicine': 'सामान्य चिकित्सा',
  cardiology: 'हृदय रोग',
  pulmonology: 'श्वसन रोग',
  gastroenterology: 'पाचन रोग',
  endocrinology: 'अंतःस्रावी रोग',
  nephrology: 'गुर्दा रोग',
  rheumatology: 'गठिया रोग',
  hematology: 'रक्त रोग',
  oncology: 'कैंसर रोग',
  'infectious-disease': 'संक्रामक रोग',
  'allergy-immunology': 'एलर्जी एवं प्रतिरक्षा',
  dermatology: 'त्वचा रोग',
  neurology: 'तंत्रिका रोग',
  psychiatry: 'मनोरोग',
  geriatrics: 'वृद्धावस्था चिकित्सा',
  'palliative-care': 'प्रशामक देखभाल',
  pediatrics: 'बाल रोग',
  neonatology: 'नवजात शिशु रोग',
  obgyn: 'स्त्री एवं प्रसूति रोग',
  'general-surgery': 'सामान्य शल्य चिकित्सा',
  'cardiothoracic-vascular-surgery': 'हृदय एवं वक्ष शल्य चिकित्सा',
  neurosurgery: 'तंत्रिका शल्य चिकित्सा',
  orthopedics: 'अस्थि रोग',
  'sports-medicine': 'खेल चिकित्सा',
  pmr: 'भौतिक चिकित्सा एवं पुनर्वास',
  urology: 'मूत्र रोग',
  ent: 'नाक, कान, गला',
  ophthalmology: 'नेत्र रोग',
  'plastic-surgery': 'प्लास्टिक सर्जरी',
  dentistry: 'दंत चिकित्सा',
  'emergency-medicine': 'आपातकालीन चिकित्सा',
  'intensive-care': 'गहन चिकित्सा इकाई',
  anesthesiology: 'निश्चेतना विभाग',
  radiology: 'रेडियोलॉजी',
  'nuclear-medicine': 'नाभिकीय चिकित्सा',
  'pathology-lab': 'पैथोलॉजी एवं प्रयोगशाला',
  // Teacher Portal + lecture hall (not departments).
  'teacher-portal': 'शिक्षक पोर्टल',
  'lecture-hall': 'व्याख्यान कक्ष',
};

export function hindiLabel(id: string): string | null {
  return HI[id] ?? null;
}

let fontsReady: Promise<void> | null = null;

/** Loads the sign fonts (Inter + Noto Sans Devanagari) for canvas drawing. */
export function loadSignFonts(): Promise<void> {
  if (fontsReady) return fontsReady;
  const faces: Array<[string, string, string]> = [
    ['Inter', '/assets/fonts/inter-600.woff2', '600'],
    ['Inter', '/assets/fonts/inter-800.woff2', '800'],
    ['Noto Sans Devanagari', '/assets/fonts/noto-devanagari-600.woff2', '600'],
  ];
  fontsReady = Promise.all(
    faces.map(async ([family, url, weight]) => {
      try {
        const f = new FontFace(family, `url(${url})`, { weight });
        await f.load();
        document.fonts.add(f);
      } catch {
        /* fall back to system fonts */
      }
    }),
  ).then(() => undefined);
  return fontsReady;
}

/** True once the sign fonts are loaded (re-renders canvases that use them). */
export function useSignFontsReady(): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    void loadSignFonts().then(() => alive && setReady(true));
    return () => {
      alive = false;
    };
  }, []);
  return ready;
}
