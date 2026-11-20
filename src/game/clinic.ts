// Polyclinic (outpatient) specialty identifiers.
//
// These IDs key both patient rosters (`POLYCLINIC_CASES`) and UI labels.
// Kept in a separate module so the store, 3D scene, HUD view, and the
// patient-data file (owned by another agent) can all import from a
// single location without a circular dependency.

export type ClinicId =
  | 'all-specialties'
  | 'internal-medicine'
  | 'cardiology'
  | 'neurology'
  | 'neurosurgery'
  | 'dermatology'
  | 'endocrinology'
  | 'gastroenterology'
  | 'pulmonology'
  | 'nephrology'
  | 'rheumatology'
  | 'hematology'
  | 'oncology'
  | 'infectious-disease'
  | 'allergy-immunology'
  | 'psychiatry'
  | 'obgyn'
  | 'urology'
  | 'ophthalmology'
  | 'ent'
  | 'orthopedics'
  | 'pmr'
  | 'pediatrics'
  | 'general-surgery'
  | 'cardiothoracic-vascular-surgery'
  | 'geriatrics'
  | 'palliative-care'
  | 'neonatology'
  | 'sports-medicine'
  | 'plastic-surgery'
  | 'dentistry'
  | 'emergency-medicine'
  | 'anesthesiology'
  | 'communication-skills';

/** Display order, also used by the specialty selector UI. The first entry
 *  is the "mixed" option that pulls cases from every specialty, so the
 *  doctor sees a rapid variety of demographics (kids, elderly, men, women)
 *  without having to switch clinics manually. */
export const CLINIC_IDS: ClinicId[] = [
  'all-specialties',
  'internal-medicine',
  'cardiology',
  'neurology',
  'neurosurgery',
  'dermatology',
  'endocrinology',
  'gastroenterology',
  'pulmonology',
  'nephrology',
  'rheumatology',
  'hematology',
  'oncology',
  'infectious-disease',
  'allergy-immunology',
  'psychiatry',
  'obgyn',
  'urology',
  'ophthalmology',
  'ent',
  'orthopedics',
  'pmr',
  'pediatrics',
  'general-surgery',
  'cardiothoracic-vascular-surgery',
  'geriatrics',
  'palliative-care',
  'neonatology',
  'sports-medicine',
  'plastic-surgery',
  'dentistry',
  'emergency-medicine',
  'anesthesiology',
  'communication-skills',
];

/** English display labels for each specialty. */
export const CLINIC_LABELS: Record<ClinicId, string> = {
  'all-specialties': 'All Specialties (mixed)',
  'internal-medicine': 'Internal Medicine',
  cardiology: 'Cardiology',
  neurology: 'Neurology',
  neurosurgery: 'Neurosurgery',
  dermatology: 'Dermatology',
  endocrinology: 'Endocrinology',
  gastroenterology: 'Gastroenterology',
  pulmonology: 'Pulmonology',
  nephrology: 'Nephrology',
  rheumatology: 'Rheumatology',
  hematology: 'Hematology',
  oncology: 'Oncology',
  'infectious-disease': 'Infectious Disease',
  'allergy-immunology': 'Allergy & Immunology',
  psychiatry: 'Psychiatry',
  obgyn: 'OB/GYN',
  urology: 'Urology',
  ophthalmology: 'Ophthalmology',
  ent: 'ENT',
  orthopedics: 'Orthopedics',
  pmr: 'Physical Medicine & Rehab',
  pediatrics: 'Pediatrics',
  'general-surgery': 'General Surgery',
  'cardiothoracic-vascular-surgery': 'Cardiothoracic & Vascular Surgery',
  geriatrics: 'Geriatrics',
  'palliative-care': 'Palliative Care',
  neonatology: 'Neonatology',
  'sports-medicine': 'Sports Medicine',
  'plastic-surgery': 'Plastic Surgery',
  dentistry: 'Dentistry',
  'emergency-medicine': 'Emergency Medicine',
  anesthesiology: 'Anesthesiology',
  'communication-skills': 'Communication Skills',
};

export const DEFAULT_CLINIC: ClinicId = 'internal-medicine';
