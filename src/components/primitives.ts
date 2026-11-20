// Legacy face-descriptor types still referenced by `data/cases.ts`.
// The MedSim UI does not draw cartoon faces; these exist only so the data
// layer type-checks.
export type FaceMood = 'neutral' | 'happy' | 'sad' | 'sick' | 'worried';
export type FaceAccessory = 'thermometer' | 'bandage';
