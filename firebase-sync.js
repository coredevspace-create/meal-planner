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
// Permet de creer des documents dans le Drive de l'utilisateur. "drive.file" est
// le scope le plus restreint possible : l'app ne voit que les fichiers qu'elle a
// elle-meme crees, jamais le reste du Drive.
provider.addScope('https://www.googleapis.com/auth/drive.file');

let unsubscribeSnapshot = null;
let authChangeCallback = null;
let remoteChangeCallback = null;
let statusCallback = null;
let driveToken = null;

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

function rememberDriveToken(result) {
  const cred = GoogleAuthProvider.credentialFromResult(result);
  if (cred && cred.accessToken) driveToken = cred.accessToken;
  return result;
}

window.MealPlannerSync = {
  signIn() {
    reportStatus('Ouverture de la fenêtre de connexion Google...');
    return signInWithPopup(auth, provider).then((result) => {
      rememberDriveToken(result);
      reportStatus('Connexion réussie : ' + result.user.email);
      return result;
    }).catch((err) => {
      reportStatus('Échec de connexion (' + err.code + ') : ' + err.message);
      throw err;
    });
  },
  isSignedIn() {
    return !!auth.currentUser;
  },
  // Le jeton Drive n'est valable que le temps de la session : s'il manque (page
  // rechargee), on redemande une autorisation. Google ne remande pas le mot de
  // passe si la session est deja ouverte, la fenetre ne fait que passer.
  ensureDriveToken() {
    if (driveToken) return Promise.resolve(driveToken);
    return signInWithPopup(auth, provider).then((result) => {
      rememberDriveToken(result);
      if (!driveToken) throw new Error("Autorisation Google Drive refusée.");
      return driveToken;
    });
  },
  // Cree un vrai document Google : Drive convertit le contenu envoye (texte ou
  // CSV) vers le format cible (Docs ou Sheets).
  createDriveFile(name, content, sourceMime, targetMime) {
    return this.ensureDriveToken().then((token) => {
      const boundary = 'mealplanner' + Date.now();
      const metadata = { name: name, mimeType: targetMime };
      const body =
        '--' + boundary + '\r\n' +
        'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
        JSON.stringify(metadata) + '\r\n' +
        '--' + boundary + '\r\n' +
        'Content-Type: ' + sourceMime + '\r\n\r\n' +
        content + '\r\n' +
        '--' + boundary + '--';
      return fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': 'multipart/related; boundary=' + boundary
        },
        body: body
      }).then((res) => res.json().then((json) => {
        if (!res.ok) {
          const msg = (json && json.error && json.error.message) || ('Erreur ' + res.status);
          if (res.status === 401 || res.status === 403) driveToken = null; // force une nouvelle autorisation
          throw new Error(msg);
        }
        return json;
      }));
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
