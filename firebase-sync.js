// Ce fichier est charge en tant que module ES (voir index.html). Sur un navigateur
// trop ancien pour comprendre <script type="module">, il est simplement ignore : le
// reste de l'app (app.js, classique) continue de fonctionner normalement en local,
// juste sans synchronisation cloud. Voir les verifications `window.MealPlannerSync`
// cote app.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup,
  signOut as fbSignOut, onAuthStateChanged
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-auth.js";
import {
  getFirestore, doc, getDoc, setDoc, onSnapshot
} from "https://www.gstatic.com/firebasejs/12.18.0/firebase-firestore.js";

const firebaseConfig = {
  apiKey: "AIzaSyDecCupVdxtTan_AVyhMnL7QcBMDLlzvpM",
  authDomain: "meal-planner-9c7d5.firebaseapp.com",
  projectId: "meal-planner-9c7d5",
  storageBucket: "meal-planner-9c7d5.firebasestorage.app",
  messagingSenderId: "1046211541281",
  appId: "1:1046211541281:web:09990388c691f12f94e660"
};

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
const provider = new GoogleAuthProvider();

let unsubscribeSnapshot = null;
let authChangeCallback = null;
let remoteChangeCallback = null;
let statusCallback = null;

function reportStatus(msg) {
  console.log('[MealPlannerSync]', msg);
  if (statusCallback) statusCallback(msg);
}

function docRefFor(uid) {
  return doc(db, 'users', uid);
}

function watchUserDoc(uid) {
  if (unsubscribeSnapshot) unsubscribeSnapshot();
  unsubscribeSnapshot = onSnapshot(docRefFor(uid), (snap) => {
    if (snap.exists() && remoteChangeCallback) {
      const data = snap.data();
      if (data && typeof data.json === 'string') {
        remoteChangeCallback(data.json);
      }
    }
  }, (err) => {
    reportStatus('Erreur de synchronisation : ' + err.message);
  });
}

reportStatus('Pont de connexion chargé, en attente de Firebase...');

onAuthStateChanged(auth, (user) => {
  if (user) {
    reportStatus('Connecté : ' + (user.email || user.uid));
    watchUserDoc(user.uid);
  } else {
    reportStatus('Non connecté.');
    if (unsubscribeSnapshot) {
      unsubscribeSnapshot();
      unsubscribeSnapshot = null;
    }
  }
  if (authChangeCallback) authChangeCallback(user);
});

window.MealPlannerSync = {
  signIn() {
    reportStatus('Ouverture de la fenêtre de connexion Google...');
    return signInWithPopup(auth, provider).then((result) => {
      reportStatus('Connexion réussie : ' + result.user.email);
      return result;
    }).catch((err) => {
      reportStatus('Échec de connexion (' + err.code + ') : ' + err.message);
      throw err;
    });
  },
  signOut() {
    return fbSignOut(auth);
  },
  onAuthChange(cb) {
    authChangeCallback = cb;
    if (auth.currentUser) cb(auth.currentUser);
  },
  onRemoteChange(cb) {
    remoteChangeCallback = cb;
  },
  onStatusChange(cb) {
    statusCallback = cb;
  },
  fetchOnce(uid) {
    return getDoc(docRefFor(uid)).then((snap) => (snap.exists() ? snap.data().json : null));
  },
  pushState(jsonString) {
    const user = auth.currentUser;
    if (!user) return;
    setDoc(docRefFor(user.uid), { json: jsonString, updatedAt: Date.now() })
      .then(() => reportStatus('Données synchronisées.'))
      .catch((err) => reportStatus('Échec de synchronisation : ' + err.message));
  }
};

window.dispatchEvent(new CustomEvent('mealplanner-sync-ready'));
