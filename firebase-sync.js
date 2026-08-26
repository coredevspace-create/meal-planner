// Ce fichier est charge en tant que module ES (voir index.html). Sur un navigateur
// trop ancien pour comprendre <script type="module">, il est simplement ignore : le
// reste de l'app (app.js, classique) continue de fonctionner normalement en local,
// juste sans synchronisation cloud. Voir les verifications `window.MealPlannerSync`
// cote app.js.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.18.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult,
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
    console.error('Erreur de synchronisation Firestore :', err);
  });
}

onAuthStateChanged(auth, (user) => {
  if (user) {
    watchUserDoc(user.uid);
  } else if (unsubscribeSnapshot) {
    unsubscribeSnapshot();
    unsubscribeSnapshot = null;
  }
  if (authChangeCallback) authChangeCallback(user);
});

getRedirectResult(auth).catch((err) => {
  console.error('Connexion Google : ', err);
  alert("La connexion Google a échoué : " + err.message);
});

window.MealPlannerSync = {
  signIn() {
    return signInWithRedirect(auth, provider);
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
  fetchOnce(uid) {
    return getDoc(docRefFor(uid)).then((snap) => (snap.exists() ? snap.data().json : null));
  },
  pushState(jsonString) {
    const user = auth.currentUser;
    if (!user) return;
    setDoc(docRefFor(user.uid), { json: jsonString, updatedAt: Date.now() })
      .catch((err) => console.error('Echec de synchronisation :', err));
  }
};

window.dispatchEvent(new CustomEvent('mealplanner-sync-ready'));
