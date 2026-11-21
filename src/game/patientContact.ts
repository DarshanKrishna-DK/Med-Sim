// Where Nurse Asha's send_to_patient delivers the prescription in this demo:
// a phone number (WhatsApp/SMS) or an email, kept in this browser only.
import { useSyncExternalStore } from 'react';

const KEY = 'medsim.patientContact.v1';
const listeners = new Set<() => void>();
let value = read();

function read(): string {
  try {
    return window.localStorage.getItem(KEY) ?? '';
  } catch {
    return '';
  }
}

export function getPatientContact(): string {
  return value;
}

export function setPatientContact(v: string) {
  value = v.trim().slice(0, 80);
  try {
    window.localStorage.setItem(KEY, value);
  } catch {
    /* private mode: session only */
  }
  for (const l of listeners) l();
}

export function usePatientContact(): string {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    getPatientContact,
    getPatientContact,
  );
}
