/**
 * Public Firebase web config + reCAPTCHA v3 site key.
 * These values are meant to be public. Never put a service-account JSON
 * or the reCAPTCHA secret key in this file.
 *
 * Paste your values from the Firebase console, then follow holland/README.md.
 */
export const firebaseConfig = {
  apiKey: "AIzaSyCPjUnTsbbiA3RUX2B2rIqPGnYodYKcm2g",
  authDomain: "holland-vacation.firebaseapp.com",
  projectId: "holland-vacation",
  storageBucket: "holland-vacation.firebasestorage.app",
  messagingSenderId: "358397745101",
  appId: "1:358397745101:web:e87ccc2c3f9b4ae1ef1684",
};

/** reCAPTCHA v3 site key used by Firebase App Check (not the secret key). */
export const recaptchaSiteKey = "6Lewkp0tAAAAAAQutGPESThgy9t8lZqdS_puJ1FT";

export function isFirebaseConfigured() {
  return Boolean(firebaseConfig.apiKey && firebaseConfig.projectId && firebaseConfig.appId);
}
