(function () {
  'use strict';
  // Ecrit en syntaxe ES5 volontairement (pas de =>, let/const, Set/Map, Array.find/includes,
  // NodeList.forEach, Pointer Events...) pour rester compatible avec le vieux navigateur
  // (WebView Android 4.4) utilise sur la tablette montee sur le frigo.

  /* ---------------------------------------------------------------------
   * Constants
   * ------------------------------------------------------------------- */
  var STORAGE_KEY = 'mealPlanner.v1';
  var DAY_NAMES = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  var MONTH_NAMES = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  var MEAL_SLOTS = ['midi', 'soir'];
  var SLOT_LABELS = { midi: 'Midi', soir: 'Soir' };
  var CATEGORY_LABELS = { protein: 'Protéine', starch: 'Féculent', vegetable: 'Légume', dairy: 'Laitier', sauce: 'Sauce / condiment' };
  var CATEGORY_ORDER = ['protein', 'starch', 'vegetable', 'dairy', 'sauce'];
  var SHOPPING_CATEGORY_ORDER = ['vegetable', 'protein', 'dairy', 'starch', 'sauce', 'other'];
  var SHOPPING_CATEGORY_LABELS = {
    vegetable: '🥦 Fruits et légumes',
    protein: '🥩 Viandes, poissons, œufs',
    dairy: '🧀 Produits laitiers',
    starch: '🍝 Féculents & épicerie',
    sauce: '🧂 Sauces & condiments',
    other: '🛒 Autres'
  };
  var HORIZON_WEEKS = 5; // semaine actuelle + ~1 mois d'avance
  var TARGET_VEG_RATIO = 0.5;
  var GENERATION_CHANCE = 0.2;

  /* ---------------------------------------------------------------------
   * Small ES5-safe helpers replacing ES6+ features
   * ------------------------------------------------------------------- */
  function pad2(n) {
    n = String(n);
    return n.length < 2 ? '0' + n : n;
  }
  function arrFind(arr, predicate) {
    for (var i = 0; i < arr.length; i++) {
      if (predicate(arr[i])) return arr[i];
    }
    return null;
  }
  function objectValues(obj) {
    var out = [];
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) out.push(obj[k]);
    }
    return out;
  }
  function mergeDefaults(target, source) {
    for (var k in source) {
      if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = source[k];
    }
    return target;
  }
  function strContains(haystack, needle) {
    return haystack.indexOf(needle) !== -1;
  }

  /* ---------------------------------------------------------------------
   * Date / week utilities
   * ------------------------------------------------------------------- */
  function fmtISO(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  function getMonday(d) {
    var date = new Date(d.getTime());
    date.setHours(0, 0, 0, 0);
    var day = date.getDay();
    var diff = day === 0 ? -6 : 1 - day;
    date.setDate(date.getDate() + diff);
    return date;
  }
  function addDays(d, n) {
    var nd = new Date(d.getTime());
    nd.setDate(nd.getDate() + n);
    return nd;
  }
  function addWeeks(d, n) { return addDays(d, n * 7); }
  function weekKeyFor(date) { return fmtISO(getMonday(date)); }
  function mondayFromKey(key) {
    var parts = key.split('-');
    return new Date(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2]));
  }
  function fmtLong(d) { return d.getDate() + ' ' + MONTH_NAMES[d.getMonth()]; }
  function isSameDay(a, b) { return fmtISO(a) === fmtISO(b); }
  function uid() { return 'id-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8); }

  /* ---------------------------------------------------------------------
   * State / persistence
   * ------------------------------------------------------------------- */
  function defaultState() {
    return { meals: [], ingredients: [], plan: {}, shoppingChecked: {}, meta: { lastMaintainedDate: null, theme: 'dark', design: 'classic', layout: 'rows', iconMode: 'auto' } };
  }
  function loadState() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        var parsed = JSON.parse(raw);
        return mergeDefaults(defaultState(), parsed);
      }
    } catch (e) { /* ignore corrupt storage */ }
    return defaultState();
  }
  var state = loadState();
  var receivingRemoteUpdate = false;
  function save() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    if (window.MealPlannerSync && !receivingRemoteUpdate) {
      window.MealPlannerSync.pushState(JSON.stringify(state));
    }
  }

  function seedIfEmpty() {
    if (state.meals.length || state.ingredients.length) return;
    function mkIng(name, category) { return { id: uid(), name: name, category: category }; }
    state.ingredients = [
      mkIng('Poulet', 'protein'), mkIng('Boeuf haché', 'protein'), mkIng('Saumon', 'protein'),
      mkIng('Oeufs', 'protein'), mkIng('Tofu', 'protein'),
      mkIng('Pâtes', 'starch'), mkIng('Riz', 'starch'), mkIng('Pommes de terre', 'starch'), mkIng('Quinoa', 'starch'),
      mkIng('Courgettes', 'vegetable'), mkIng('Brocolis', 'vegetable'), mkIng('Carottes', 'vegetable'),
      mkIng('Épinards', 'vegetable'), mkIng('Tomates', 'vegetable'),
      mkIng('Crème fraîche', 'dairy'), mkIng('Fromage râpé', 'dairy'),
      mkIng('Sauce tomate', 'sauce'), mkIng('Sauce soja', 'sauce')
    ];
    function mkMeal(name, ingredientNames, tags) {
      return {
        id: uid(), name: name,
        ingredients: ingredientNames.map(function (n) { return { name: n, ingredientId: null, category: null }; }),
        tags: tags, recipe: '', excludedSlots: [], source: 'manual', usageCount: 0, lastUsedWeekKey: null, history: []
      };
    }
    state.meals = [
      mkMeal('Salade César au poulet', ['Poulet', 'Salade', 'Parmesan', 'Croûtons'], { protein: true, starch: false, veg: true }),
      mkMeal('Omelette aux légumes', ['Oeufs', 'Poivrons', 'Oignons'], { protein: true, starch: false, veg: true }),
      mkMeal('Steak-frites', ['Steak', 'Pommes de terre'], { protein: true, starch: true, veg: false })
    ];
    save();
  }

  /* ---------------------------------------------------------------------
   * Plan mutation helpers (keep meal.usageCount / history / lastUsedWeekKey coherent)
   * ------------------------------------------------------------------- */
  function slotKey(dayIndex, slot) { return dayIndex + '_' + slot; }
  function recomputeLastUsed(meal) {
    if (!meal.history.length) { meal.lastUsedWeekKey = null; return; }
    var weeks = meal.history.map(function (h) { return h.split(':')[0]; });
    weeks.sort();
    meal.lastUsedWeekKey = weeks[weeks.length - 1];
  }
  function unassignSlot(weekKey, key) {
    if (!state.plan[weekKey]) return;
    var mealId = state.plan[weekKey][key];
    if (mealId) {
      var m = arrFind(state.meals, function (mm) { return mm.id === mealId; });
      if (m) {
        m.usageCount = Math.max(0, m.usageCount - 1);
        var histKey = weekKey + ':' + key;
        m.history = m.history.filter(function (h) { return h !== histKey; });
        recomputeLastUsed(m);
      }
    }
    state.plan[weekKey][key] = null;
  }
  function assignSlot(weekKey, key, mealId) {
    if (!state.plan[weekKey]) state.plan[weekKey] = {};
    unassignSlot(weekKey, key);
    var m = arrFind(state.meals, function (mm) { return mm.id === mealId; });
    if (m) {
      m.usageCount = (m.usageCount || 0) + 1;
      m.history.push(weekKey + ':' + key);
      recomputeLastUsed(m);
    }
    state.plan[weekKey][key] = mealId;
  }
  function swapSlots(weekKey, keyA, keyB) {
    if (!state.plan[weekKey]) state.plan[weekKey] = {};
    var a = state.plan[weekKey][keyA] || null;
    var b = state.plan[weekKey][keyB] || null;
    state.plan[weekKey][keyA] = b;
    state.plan[weekKey][keyB] = a;
  }
  function removeMealEverywhere(mealId) {
    for (var wk in state.plan) {
      if (!Object.prototype.hasOwnProperty.call(state.plan, wk)) continue;
      for (var key in state.plan[wk]) {
        if (!Object.prototype.hasOwnProperty.call(state.plan[wk], key)) continue;
        if (state.plan[wk][key] === mealId) state.plan[wk][key] = null;
      }
    }
    state.meals = state.meals.filter(function (m) { return m.id !== mealId; });
  }
  function sameNormalizedName(a, b) {
    return normalizeSearch(a) === normalizeSearch(b);
  }
  function findMealByExactName(name, excludeId) {
    return arrFind(state.meals, function (m) { return m.id !== excludeId && sameNormalizedName(m.name, name); });
  }
  // Cherche si un repas portant ce nom est deja planifie ailleurs dans la semaine
  // donnee (utilise pour avertir avant de creer un doublon sur la meme semaine).
  function mealNameUsedElsewhereInWeek(name, weekKey, excludeKey) {
    if (!weekKey || !state.plan[weekKey]) return false;
    for (var k in state.plan[weekKey]) {
      if (!Object.prototype.hasOwnProperty.call(state.plan[weekKey], k)) continue;
      if (k === excludeKey) continue;
      var mid = state.plan[weekKey][k];
      if (!mid) continue;
      var m = arrFind(state.meals, function (mm) { return mm.id === mid; });
      if (m && sameNormalizedName(m.name, name)) return true;
    }
    return false;
  }
  function duplicateWarnings(name, excludeMealId, slotContext) {
    var warnings = [];
    if (findMealByExactName(name, excludeMealId)) {
      warnings.push('Un repas nommé "' + name + '" existe déjà dans la bibliothèque.');
    }
    if (slotContext && mealNameUsedElsewhereInWeek(name, slotContext.weekKey, slotContext.key)) {
      warnings.push('Ce repas est déjà prévu ailleurs cette semaine.');
    }
    return warnings;
  }

  /* ---------------------------------------------------------------------
   * Generator: compose a meal from the raw ingredient pool, and auto-fill
   * ------------------------------------------------------------------- */
  function randPick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
  function shuffledSample(arr, n) {
    var copy = arr.slice();
    for (var i = copy.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = copy[i];
      copy[i] = copy[j];
      copy[j] = tmp;
    }
    return copy.slice(0, n);
  }
  function ingredientsPoolViable() {
    return state.ingredients.some(function (i) { return i.category === 'protein'; }) &&
      state.ingredients.some(function (i) { return i.category === 'starch'; });
  }
  function typesOf(meal, category) {
    var out = [];
    for (var i = 0; i < meal.ingredients.length; i++) {
      if (meal.ingredients[i].category === category) out.push(normalizeSearch(meal.ingredients[i].name));
    }
    return out;
  }
  function proteinTypesOf(meal) { return typesOf(meal, 'protein'); }
  function starchTypesOf(meal) { return typesOf(meal, 'starch'); }
  function linearSlotIndex(dayIndex, slot) {
    return dayIndex * MEAL_SLOTS.length + (slot === 'midi' ? 0 : 1);
  }
  function slotFromLinearIndex(linIdx) {
    return { dayIndex: Math.floor(linIdx / MEAL_SLOTS.length), slot: MEAL_SLOTS[linIdx % MEAL_SLOTS.length] };
  }
  // Types (proteine ou feculent) utilises dans les {lookback} cases precedentes de la
  // semaine (distance 1 = case juste avant), pour eviter de reservir la meme
  // viande/poisson/oeuf ou le meme feculent plusieurs fois de suite.
  function recentTypesBefore(weekKey, dayIndex, slot, lookback, category) {
    var linIdx = linearSlotIndex(dayIndex, slot);
    var out = [];
    for (var back = 1; back <= lookback; back++) {
      var idx = linIdx - back;
      if (idx < 0) break;
      var pos = slotFromLinearIndex(idx);
      var k = slotKey(pos.dayIndex, pos.slot);
      var mealId = state.plan[weekKey] ? state.plan[weekKey][k] : null;
      if (!mealId) continue;
      var m = arrFind(state.meals, function (mm) { return mm.id === mealId; });
      if (!m) continue;
      var types = typesOf(m, category);
      for (var ti = 0; ti < types.length; ti++) out.push({ type: types[ti], distance: back });
    }
    return out;
  }

  function generateMealFromIngredients(avoidProteinTypes, avoidStarchTypes) {
    var proteins = state.ingredients.filter(function (i) { return i.category === 'protein'; });
    var starches = state.ingredients.filter(function (i) { return i.category === 'starch'; });
    if (!proteins.length || !starches.length) return null;
    var vegetables = state.ingredients.filter(function (i) { return i.category === 'vegetable'; });
    var extras = state.ingredients.filter(function (i) { return i.category === 'dairy' || i.category === 'sauce'; });

    var proteinChoices = proteins;
    if (avoidProteinTypes && avoidProteinTypes.length) {
      var filteredProteins = proteins.filter(function (i) { return avoidProteinTypes.indexOf(normalizeSearch(i.name)) === -1; });
      if (filteredProteins.length) proteinChoices = filteredProteins;
    }
    var starchChoices = starches;
    if (avoidStarchTypes && avoidStarchTypes.length) {
      var filteredStarches = starches.filter(function (i) { return avoidStarchTypes.indexOf(normalizeSearch(i.name)) === -1; });
      if (filteredStarches.length) starchChoices = filteredStarches;
    }
    var protein = randPick(proteinChoices);
    var starch = randPick(starchChoices);
    var vegCount = vegetables.length ? Math.floor(Math.random() * Math.min(3, vegetables.length + 1)) : 0;
    var chosenVeg = shuffledSample(vegetables, vegCount);
    var extra = (extras.length && Math.random() < 0.4) ? randPick(extras) : null;

    var name = protein.name + ' avec ' + starch.name;
    if (chosenVeg.length) {
      var vegNames = chosenVeg.map(function (v) { return v.name; });
      name += ' et ' + vegNames.join(', ');
    }

    var picked = [protein, starch].concat(chosenVeg);
    if (extra) picked.push(extra);

    return {
      id: uid(),
      name: name,
      ingredients: picked.map(function (i) { return { name: i.name, ingredientId: i.id, category: i.category }; }),
      tags: { protein: true, starch: true, veg: vegCount > 0 },
      recipe: '',
      excludedSlots: [],
      source: 'generated',
      usageCount: 0,
      lastUsedWeekKey: null,
      history: []
    };
  }

  function isExcludedFromSlot(meal, key) {
    return !!(meal.excludedSlots && meal.excludedSlots.indexOf(key) !== -1);
  }
  function chooseMealForSlot(weekKey, dayIndex, slot, usedThisWeekIds, vegCountSoFar, filledSoFar, proteinCountSoFar, starchCountSoFar) {
    var thisKey = slotKey(dayIndex, slot);
    var candidates = state.meals.filter(function (m) { return !usedThisWeekIds[m.id] && !isExcludedFromSlot(m, thisKey); });
    var wantsGeneration = candidates.length === 0 || (Math.random() < GENERATION_CHANCE && ingredientsPoolViable());
    var recentProteins = recentTypesBefore(weekKey, dayIndex, slot, 2, 'protein');
    var recentStarches = recentTypesBefore(weekKey, dayIndex, slot, 2, 'starch');

    if (wantsGeneration) {
      var generated = generateMealFromIngredients(
        recentProteins.map(function (r) { return r.type; }),
        recentStarches.map(function (r) { return r.type; })
      );
      if (generated) {
        var dup = arrFind(state.meals, function (m) { return m.name === generated.name; });
        if (dup) {
          if (!usedThisWeekIds[dup.id] && !isExcludedFromSlot(dup, thisKey)) return dup;
          // deja utilise cette semaine sous ce nom exact (ou exclu pour cette case) : on retombe sur le tirage normal
        } else {
          state.meals.push(generated);
          return generated;
        }
      }
    }
    if (!candidates.length) return null;

    function weeksSince(m) {
      if (!m.lastUsedWeekKey) return 999;
      var diffDays = (mondayFromKey(weekKey).getTime() - mondayFromKey(m.lastUsedWeekKey).getTime()) / 86400000;
      return diffDays / 7;
    }
    function recencyPenalty(mTypes, recent, countSoFar) {
      if (!mTypes.length) return 0;
      var penalty = 0;
      for (var r = 0; r < recent.length; r++) {
        if (mTypes.indexOf(recent[r].type) !== -1) penalty += recent[r].distance === 1 ? 8 : 4;
      }
      for (var t = 0; t < mTypes.length; t++) penalty += (countSoFar[mTypes[t]] || 0) * 1.5;
      return penalty;
    }
    function score(m) {
      var s = Math.min(weeksSince(m), 12);
      var currentRatio = vegCountSoFar / (filledSoFar || 1);
      if (m.tags.veg && currentRatio < TARGET_VEG_RATIO) s += 3;
      if (!m.tags.veg && currentRatio >= TARGET_VEG_RATIO) s -= 1;
      s -= recencyPenalty(proteinTypesOf(m), recentProteins, proteinCountSoFar);
      s -= recencyPenalty(starchTypesOf(m), recentStarches, starchCountSoFar);
      s += Math.random() * 1.5;
      return s;
    }
    var sorted = candidates.slice().sort(function (a, b) { return score(b) - score(a); });
    var top = sorted.slice(0, Math.min(3, sorted.length));
    return randPick(top);
  }

  function addToTypeCount(countMap, types) {
    for (var i = 0; i < types.length; i++) countMap[types[i]] = (countMap[types[i]] || 0) + 1;
  }

  function autofillWeek(weekKey, opts) {
    opts = opts || { onlyEmpty: true };
    if (!state.plan[weekKey]) state.plan[weekKey] = {};
    var usedThisWeekIds = {};
    var filledSoFar = 0;
    var existingValues = objectValues(state.plan[weekKey]);
    var vi;
    for (vi = 0; vi < existingValues.length; vi++) {
      var vId = existingValues[vi];
      if (vId && !usedThisWeekIds[vId]) { usedThisWeekIds[vId] = true; filledSoFar++; }
    }
    var vegCountSoFar = 0;
    var proteinCountSoFar = {};
    var starchCountSoFar = {};
    for (var idKey in usedThisWeekIds) {
      if (!Object.prototype.hasOwnProperty.call(usedThisWeekIds, idKey)) continue;
      var mm = arrFind(state.meals, function (x) { return x.id === idKey; });
      if (mm && mm.tags.veg) vegCountSoFar++;
      if (mm) {
        addToTypeCount(proteinCountSoFar, proteinTypesOf(mm));
        addToTypeCount(starchCountSoFar, starchTypesOf(mm));
      }
    }

    for (var dayIndex = 0; dayIndex < 7; dayIndex++) {
      for (var si = 0; si < MEAL_SLOTS.length; si++) {
        var slot = MEAL_SLOTS[si];
        var key = slotKey(dayIndex, slot);
        if (opts.onlyEmpty && state.plan[weekKey][key]) continue;
        var meal = chooseMealForSlot(weekKey, dayIndex, slot, usedThisWeekIds, vegCountSoFar, filledSoFar, proteinCountSoFar, starchCountSoFar);
        if (!meal) continue;
        assignSlot(weekKey, key, meal.id);
        usedThisWeekIds[meal.id] = true;
        filledSoFar++;
        if (meal.tags.veg) vegCountSoFar++;
        addToTypeCount(proteinCountSoFar, proteinTypesOf(meal));
        addToTypeCount(starchCountSoFar, starchTypesOf(meal));
      }
    }
    save();
  }

  // Recalcule les compteurs de la semaine (proteines/feculents/legumes/repas deja
  // utilises) en ignorant une case donnee, pour pouvoir chercher un remplacement
  // coherent pour cette case precise sans se baser sur elle-meme.
  function computeWeekAggregatesExcluding(weekKey, excludeKey) {
    var usedThisWeekIds = {};
    var filledSoFar = 0;
    var vegCountSoFar = 0;
    var proteinCountSoFar = {};
    var starchCountSoFar = {};
    for (var d = 0; d < 7; d++) {
      for (var s = 0; s < MEAL_SLOTS.length; s++) {
        var k = slotKey(d, MEAL_SLOTS[s]);
        if (k === excludeKey) continue;
        var mid = state.plan[weekKey] ? state.plan[weekKey][k] : null;
        if (!mid) continue;
        if (!usedThisWeekIds[mid]) { usedThisWeekIds[mid] = true; filledSoFar++; }
        var mm = arrFind(state.meals, function (x) { return x.id === mid; });
        if (mm) {
          if (mm.tags.veg) vegCountSoFar++;
          addToTypeCount(proteinCountSoFar, proteinTypesOf(mm));
          addToTypeCount(starchCountSoFar, starchTypesOf(mm));
        }
      }
    }
    return { usedThisWeekIds: usedThisWeekIds, filledSoFar: filledSoFar, vegCountSoFar: vegCountSoFar, proteinCountSoFar: proteinCountSoFar, starchCountSoFar: starchCountSoFar };
  }

  // Corrige les repas deja planifies (generes avant une amelioration de l'algorithme,
  // ou simplement malchanceux) qui reservent la meme protein OU le meme feculent que
  // la case juste avant ou juste avant-avant. Ne touche pas aux cases qui ne posent
  // pas de probleme.
  function repairWeekClashes(weekKey) {
    if (!state.plan[weekKey]) return 0;
    var fixedCount = 0;
    for (var dayIndex = 0; dayIndex < 7; dayIndex++) {
      for (var si = 0; si < MEAL_SLOTS.length; si++) {
        var slot = MEAL_SLOTS[si];
        var key = slotKey(dayIndex, slot);
        var mealId = state.plan[weekKey][key];
        if (!mealId) continue;
        var meal = arrFind(state.meals, function (m) { return m.id === mealId; });
        if (!meal) continue;
        var proteinTypes = proteinTypesOf(meal);
        var starchTypes = starchTypesOf(meal);
        if (!proteinTypes.length && !starchTypes.length) continue;
        var recentProteins = recentTypesBefore(weekKey, dayIndex, slot, 2, 'protein');
        var recentStarches = recentTypesBefore(weekKey, dayIndex, slot, 2, 'starch');
        var clash = recentProteins.some(function (r) { return proteinTypes.indexOf(r.type) !== -1; }) ||
          recentStarches.some(function (r) { return starchTypes.indexOf(r.type) !== -1; });
        if (!clash) continue;
        var agg = computeWeekAggregatesExcluding(weekKey, key);
        var replacement = chooseMealForSlot(weekKey, dayIndex, slot, agg.usedThisWeekIds, agg.vegCountSoFar, agg.filledSoFar, agg.proteinCountSoFar, agg.starchCountSoFar);
        if (replacement && replacement.id !== mealId) {
          assignSlot(weekKey, key, replacement.id);
          fixedCount++;
        }
      }
    }
    if (fixedCount) save();
    return fixedCount;
  }

  function maintainHorizon() {
    var monday = getMonday(new Date());
    for (var i = 0; i < HORIZON_WEEKS; i++) {
      var wk = weekKeyFor(addWeeks(monday, i));
      autofillWeek(wk, { onlyEmpty: true });
    }
    save();
  }

  /* ---------------------------------------------------------------------
   * View / navigation state
   * ------------------------------------------------------------------- */
  var viewingMonday = getMonday(new Date());
  var currentTab = 'planning';

  /* ---------------------------------------------------------------------
   * DOM refs
   * ------------------------------------------------------------------- */
  function $(sel) { return document.querySelector(sel); }
  var topbarEl = $('.topbar');
  var weekLabelEl = $('#week-label');
  var weekSublabelEl = $('#week-sublabel');
  var gridEl = $('#planning-grid');
  var mealListEl = $('#meal-list');
  var ingredientListEl = $('#ingredient-list');
  var shoppingListEl = $('#shopping-list');
  var shoppingRangeNoteEl = $('#shopping-range-note');
  var modalRoot = $('#modal-root');
  var syncUnavailableEl = $('#settings-sync-unavailable');
  var authUserInfoEl = $('#auth-user-info');
  var authUserNameEl = $('#auth-user-name');
  var authSignedOutHintEl = $('#auth-signed-out-hint');
  var signInBtn = $('#btn-google-signin');
  var signOutBtn = $('#btn-google-signout');
  var authDebugEl = $('#auth-debug-info');
  var themeDarkBtn = $('#btn-theme-dark');
  var themeLightBtn = $('#btn-theme-light');
  var designClassicBtn = $('#btn-design-classic');
  var designRoundBtn = $('#btn-design-round');
  var designCompactBtn = $('#btn-design-compact');
  var layoutRowsBtn = $('#btn-layout-rows');
  var layoutColumnsBtn = $('#btn-layout-columns');
  var layoutListBtn = $('#btn-layout-list');
  var iconsAutoBtn = $('#btn-icons-auto');
  var iconsEmojiBtn = $('#btn-icons-emoji');
  var iconsTextBtn = $('#btn-icons-text');

  /* ---------------------------------------------------------------------
   * Rendering: week label
   * ------------------------------------------------------------------- */
  function renderWeekLabel() {
    var sunday = addDays(viewingMonday, 6);
    weekLabelEl.textContent = fmtLong(viewingMonday) + ' → ' + fmtLong(sunday);
    var currentMonday = getMonday(new Date());
    var wk = fmtISO(viewingMonday);
    var curWk = fmtISO(currentMonday);
    if (wk === curWk) {
      weekSublabelEl.textContent = 'Semaine actuelle';
    } else if (viewingMonday.getTime() < currentMonday.getTime()) {
      weekSublabelEl.textContent = 'Semaine passée';
    } else {
      weekSublabelEl.textContent = 'Semaine à venir';
    }
  }

  /* ---------------------------------------------------------------------
   * Icones : les vieux Android (4.4) n'ont que les emoji d'avant 2013, donc
   * 🥦 🥩 🧀 🧱... s'affichent en carre vide. On detecte le support et on
   * bascule sur des libelles texte si besoin (reglable dans Parametres).
   * ------------------------------------------------------------------- */
  var recentEmojiSupported = null; // calcule une seule fois, a la demande
  function detectRecentEmojiSupport() {
    try {
      var canvas = document.createElement('canvas');
      if (!canvas.getContext) return false;
      canvas.width = 24; canvas.height = 24;
      var ctx = canvas.getContext('2d');
      if (!ctx || !ctx.fillText) return false;
      ctx.textBaseline = 'top';
      ctx.font = '20px sans-serif';
      ctx.fillStyle = '#000000';
      ctx.fillText('🥦', 0, 0); // brocoli : emoji de 2016, absent sur Android 4.4
      var data = ctx.getImageData(0, 0, 24, 24).data;
      for (var i = 0; i < data.length; i += 4) {
        if (data[i + 3] === 0) continue;
        // un emoji reellement supporte est rendu en couleur ; un carre vide est monochrome
        if (data[i] !== data[i + 1] || data[i + 1] !== data[i + 2]) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }
  function useTextIcons() {
    var mode = (state.meta && state.meta.iconMode) || 'auto';
    if (mode === 'text') return true;
    if (mode === 'emoji') return false;
    if (recentEmojiSupported === null) recentEmojiSupported = detectRecentEmojiSupport();
    return !recentEmojiSupported;
  }

  function tagIcons(meal) {
    if (useTextIcons()) {
      var out = '';
      if (meal.tags.protein) out += '<span class="tag-mini tag-mini-protein">P</span>';
      if (meal.tags.starch) out += '<span class="tag-mini tag-mini-starch">F</span>';
      if (meal.tags.veg) out += '<span class="tag-mini tag-mini-veg">L</span>';
      return out;
    }
    var icons = '';
    if (meal.tags.protein) icons += '🥩';
    if (meal.tags.starch) icons += '🍝';
    if (meal.tags.veg) icons += '🥦';
    return icons;
  }
  function tagBadges(tags) {
    var out = '';
    if (tags.protein) out += '<span class="tag tag-protein">Protéine</span>';
    if (tags.starch) out += '<span class="tag tag-starch">Féculent</span>';
    if (tags.veg) out += '<span class="tag tag-veg">Légume</span>';
    return out;
  }

  /* ---------------------------------------------------------------------
   * Rendering: planning grid
   * ------------------------------------------------------------------- */
  function el(tag, attrs, html) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (Object.prototype.hasOwnProperty.call(attrs, k)) e.setAttribute(k, attrs[k]);
    }
    if (html !== undefined) e.innerHTML = html;
    return e;
  }
  function escapeHtml(s) {
    var map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(s).replace(/[&<>"']/g, function (c) { return map[c]; });
  }
  function normalizeSearch(s) {
    return String(s)
      .toLowerCase()
      .replace(/[àáâãäå]/g, 'a')
      .replace(/[éèêë]/g, 'e')
      .replace(/[ìíîï]/g, 'i')
      .replace(/[òóôõö]/g, 'o')
      .replace(/[ùúûü]/g, 'u')
      .replace(/ç/g, 'c')
      .replace(/ñ/g, 'n');
  }
  function tokenizeNormalized(normalizedStr) {
    return normalizedStr.split(/[^a-z0-9]+/).filter(function (w) { return w; });
  }
  // Distance de Levenshtein (nombre minimal d'ajouts/suppressions/substitutions
  // pour passer d'un mot a l'autre) : sert a tolerer les fautes de frappe.
  function levenshtein(a, b) {
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [];
    var i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      var cur = [i];
      for (j = 1; j <= n; j++) {
        var cost = a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      prev = cur;
    }
    return prev[n];
  }
  function typoTolerance(len) {
    if (len <= 2) return 0;
    if (len <= 5) return 1;
    return 2;
  }
  function wordMatchesToken(word, token) {
    if (strContains(token, word)) return true; // sous-chaine/prefixe (recherche partielle normale)
    return levenshtein(word, token) <= typoTolerance(word.length);
  }

  // Construit une case repas (contenu identique quelle que soit la disposition).
  // captionSlot : si fourni, affiche "Midi"/"Soir" en petit dans la case (utile
  // pour les dispositions ou il n'y a pas de colonne d'en-tete).
  function buildMealCell(weekKey, dayIndex, slot, isToday, extraClass, captionSlot) {
    var key = slotKey(dayIndex, slot);
    var mealId = state.plan[weekKey] ? state.plan[weekKey][key] : null;
    var meal = mealId ? arrFind(state.meals, function (m) { return m.id === mealId; }) : null;
    var cellClass = 'meal-slot ' + extraClass + (isToday ? ' today-slot' : '') + (!meal ? ' empty' : '') + (meal && meal.source === 'generated' ? ' auto-badge' : '');
    var cellHtml = '';
    if (captionSlot) cellHtml += '<div class="slot-caption">' + SLOT_LABELS[slot] + '</div>';
    cellHtml += meal ? ('<div class="meal-name">' + escapeHtml(meal.name) + '</div><div class="meal-tags">' + tagIcons(meal) + '</div>') : '+ Ajouter';
    return el('div', { class: cellClass, 'data-day': String(dayIndex), 'data-slot': slot }, cellHtml);
  }

  // Disposition "Lignes" (classique) : jours en lignes, Midi/Soir en colonnes.
  function renderPlanningGridRows(weekKey, today) {
    var headerRow = document.createElement('div');
    headerRow.className = 'grid-row grid-row-header';
    headerRow.appendChild(el('div', { class: 'grid-header-cell grid-col-label' }, ''));
    for (var si = 0; si < MEAL_SLOTS.length; si++) {
      headerRow.appendChild(el('div', { class: 'grid-header-cell grid-col-slot' }, SLOT_LABELS[MEAL_SLOTS[si]]));
    }
    gridEl.appendChild(headerRow);

    for (var dayIndex = 0; dayIndex < 7; dayIndex++) {
      var dayDate = addDays(viewingMonday, dayIndex);
      var isToday = isSameDay(dayDate, today);
      var row = document.createElement('div');
      row.className = 'grid-row';
      var dayLabel = el('div', { class: 'day-label grid-col-label' + (isToday ? ' today' : '') },
        DAY_NAMES[dayIndex] + '<div class="day-date">' + fmtLong(dayDate) + '</div>');
      row.appendChild(dayLabel);
      for (var si2 = 0; si2 < MEAL_SLOTS.length; si2++) {
        row.appendChild(buildMealCell(weekKey, dayIndex, MEAL_SLOTS[si2], isToday, 'grid-col-slot', null));
      }
      gridEl.appendChild(row);
    }
  }

  // Disposition "Colonnes" : jours en haut de gauche a droite, repas en dessous.
  function renderPlanningGridColumns(weekKey, today) {
    var row = document.createElement('div');
    row.className = 'grid-columns-row';
    for (var dayIndex = 0; dayIndex < 7; dayIndex++) {
      var dayDate = addDays(viewingMonday, dayIndex);
      var isToday = isSameDay(dayDate, today);
      var col = document.createElement('div');
      col.className = 'grid-day-col';
      var dayLabel = el('div', { class: 'day-label day-label-top' + (isToday ? ' today' : '') },
        DAY_NAMES[dayIndex] + '<div class="day-date">' + fmtLong(dayDate) + '</div>');
      col.appendChild(dayLabel);
      for (var si = 0; si < MEAL_SLOTS.length; si++) {
        col.appendChild(buildMealCell(weekKey, dayIndex, MEAL_SLOTS[si], isToday, 'grid-cell-col', MEAL_SLOTS[si]));
      }
      row.appendChild(col);
    }
    gridEl.appendChild(row);
  }

  // Disposition "Agenda" : liste verticale, un bloc par jour avec ses deux repas
  // en pleine largeur (pratique en orientation portrait).
  function renderPlanningGridList(weekKey, today) {
    for (var dayIndex = 0; dayIndex < 7; dayIndex++) {
      var dayDate = addDays(viewingMonday, dayIndex);
      var isToday = isSameDay(dayDate, today);
      var header = el('div', { class: 'list-day-header' + (isToday ? ' today' : '') },
        DAY_NAMES[dayIndex] + ' <span class="day-date-inline">' + fmtLong(dayDate) + '</span>');
      gridEl.appendChild(header);
      for (var si = 0; si < MEAL_SLOTS.length; si++) {
        gridEl.appendChild(buildMealCell(weekKey, dayIndex, MEAL_SLOTS[si], isToday, 'grid-cell-list', MEAL_SLOTS[si]));
      }
    }
  }

  function renderPlanningGrid() {
    var weekKey = fmtISO(viewingMonday);
    var today = new Date();
    gridEl.innerHTML = '';
    var layout = (state.meta && state.meta.layout) || 'rows';
    if (layout === 'columns') {
      renderPlanningGridColumns(weekKey, today);
    } else if (layout === 'list') {
      renderPlanningGridList(weekKey, today);
    } else {
      renderPlanningGridRows(weekKey, today);
    }
    applyIconMode();
  }

  /* ---------------------------------------------------------------------
   * Rendering: meal library
   * ------------------------------------------------------------------- */
  var mealSearchQuery = '';
  function tagSearchText(meal) {
    var words = [];
    if (meal.tags.protein) words.push(CATEGORY_LABELS.protein);
    if (meal.tags.starch) words.push(CATEGORY_LABELS.starch);
    if (meal.tags.veg) words.push(CATEGORY_LABELS.vegetable);
    return words.join(' ');
  }
  function mealSearchHaystack(meal) {
    var ingredientNames = meal.ingredients.map(function (i) { return i.name; }).join(' ');
    return normalizeSearch([meal.name, tagSearchText(meal), ingredientNames].join(' '));
  }
  function mealMatchesQuery(meal, query) {
    var rawWords = normalizeSearch(query).split(/\s+/);
    var words = rawWords.filter(function (w) { return w; });
    if (!words.length) return true;
    var haystackTokens = tokenizeNormalized(mealSearchHaystack(meal));
    return words.every(function (w) {
      for (var i = 0; i < haystackTokens.length; i++) {
        if (wordMatchesToken(w, haystackTokens[i])) return true;
      }
      return false;
    });
  }
  function renderMealList() {
    mealListEl.innerHTML = '';
    if (!state.meals.length) {
      mealListEl.appendChild(el('div', { class: 'empty-hint' }, 'Aucun repas pour le moment. Ajoutes-en un !'));
      return;
    }
    var filtered = state.meals.filter(function (meal) { return mealMatchesQuery(meal, mealSearchQuery); });
    if (!filtered.length) {
      mealListEl.appendChild(el('div', { class: 'empty-hint' }, 'Aucun repas ne correspond à cette recherche.'));
      return;
    }
    filtered.slice().sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (meal) {
      var card = el('div', { class: 'card' }, '');
      var ingredientsLine = meal.ingredients.map(function (i) { return escapeHtml(i.name); }).join(', ') || '—';
      var main = el('div', { class: 'card-main card-main-link' },
        '<div class="card-title">' + escapeHtml(meal.name) + '</div>' +
        '<div class="card-sub">' + tagBadges(meal.tags) + '</div>' +
        '<div class="card-sub">' + ingredientsLine + '</div>');
      main.addEventListener('click', function () { openRecipeView(meal, null); });
      var actions = el('div', { class: 'card-actions' }, '');
      var editBtn = el('button', { class: 'icon-btn', 'data-icon': 'edit' }, '✏️');
      editBtn.addEventListener('click', function () { openMealModal({ mode: 'edit', meal: meal }); });
      var delBtn = el('button', { class: 'icon-btn', 'data-icon': 'delete' }, '🗑');
      delBtn.addEventListener('click', function () {
        if (confirm('Supprimer "' + meal.name + '" ?')) {
          removeMealEverywhere(meal.id);
          save();
          renderMealList();
          renderPlanningGrid();
        }
      });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);
      card.appendChild(main);
      card.appendChild(actions);
      mealListEl.appendChild(card);
    });
  }

  /* ---------------------------------------------------------------------
   * Rendering: ingredient pool
   * ------------------------------------------------------------------- */
  function renderIngredientList() {
    ingredientListEl.innerHTML = '';
    if (!state.ingredients.length) {
      ingredientListEl.appendChild(el('div', { class: 'empty-hint' }, 'Aucun ingrédient. Ajoutes-en pour permettre la génération automatique de repas.'));
      return;
    }
    CATEGORY_ORDER.forEach(function (cat) {
      var items = state.ingredients.filter(function (i) { return i.category === cat; });
      if (!items.length) return;
      ingredientListEl.appendChild(el('div', { class: 'muted' }, CATEGORY_LABELS[cat]));
      items.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (ing) {
        var card = el('div', { class: 'card' }, '');
        var main = el('div', { class: 'card-main' }, '<div class="card-title">' + escapeHtml(ing.name) + '</div>');
        var actions = el('div', { class: 'card-actions' }, '');
        var editBtn = el('button', { class: 'icon-btn', 'data-icon': 'edit' }, '✏️');
        editBtn.addEventListener('click', function () { openIngredientModal({ mode: 'edit', ingredient: ing }); });
        var delBtn = el('button', { class: 'icon-btn', 'data-icon': 'delete' }, '🗑');
        delBtn.addEventListener('click', function () {
          if (confirm('Supprimer "' + ing.name + '" ?')) {
            state.ingredients = state.ingredients.filter(function (i) { return i.id !== ing.id; });
            save();
            renderIngredientList();
          }
        });
        actions.appendChild(editBtn);
        actions.appendChild(delBtn);
        card.appendChild(main);
        card.appendChild(actions);
        ingredientListEl.appendChild(card);
      });
    });
  }

  /* ---------------------------------------------------------------------
   * Rendering: shopping list
   * ------------------------------------------------------------------- */
  function weekdayIndexOf(day) {
    return Math.round((day.getTime() - getMonday(day).getTime()) / 86400000);
  }
  // Devine le rayon magasin d'un ingredient : categorie explicite sur cet
  // ingredient si connue, sinon on cherche un ingredient du meme nom dans le pool
  // (utile pour les repas saisis a la main sans lien vers le pool), sinon "other".
  function resolveIngredientCategory(name, explicitCategory) {
    if (explicitCategory) return explicitCategory;
    var normalized = normalizeSearch(name);
    var found = arrFind(state.ingredients, function (i) { return normalizeSearch(i.name) === normalized; });
    return (found && found.category) ? found.category : 'other';
  }
  // Additionne les ingredients necessaires jour par jour entre startDate et endDate
  // (inclus), en traversant au besoin plusieurs semaines. Si respectChecked est
  // vrai, un ingredient deja coche pour la semaine d'un jour donne n'est pas compte
  // pour ce jour-la (mais peut l'etre pour un autre jour d'une autre semaine).
  function aggregateShoppingListRange(startDate, endDate, respectChecked) {
    var counts = {};
    var cursor = new Date(startDate.getTime());
    var end = new Date(endDate.getTime());
    while (cursor.getTime() <= end.getTime()) {
      var weekKey = weekKeyFor(cursor);
      var dayIndex = weekdayIndexOf(cursor);
      var weekPlan = state.plan[weekKey] || {};
      var checkedMap = state.shoppingChecked[weekKey] || {};
      for (var si = 0; si < MEAL_SLOTS.length; si++) {
        var mealId = weekPlan[slotKey(dayIndex, MEAL_SLOTS[si])];
        if (!mealId) continue;
        var meal = arrFind(state.meals, function (m) { return m.id === mealId; });
        if (!meal) continue;
        for (var ii = 0; ii < meal.ingredients.length; ii++) {
          var ing = meal.ingredients[ii];
          var k = ing.name.trim().toLowerCase();
          if (!k) continue;
          if (respectChecked && checkedMap[k]) continue;
          if (!counts[k]) counts[k] = { displayName: ing.name.trim(), count: 0, category: resolveIngredientCategory(ing.name, ing.category) };
          counts[k].count++;
        }
      }
      cursor = addDays(cursor, 1);
    }
    return counts;
  }
  function categorizedKeys(counts) {
    var byCat = {};
    var keys = Object.keys(counts);
    SHOPPING_CATEGORY_ORDER.forEach(function (cat) { byCat[cat] = []; });
    keys.forEach(function (k) {
      var cat = counts[k].category || 'other';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(k);
    });
    SHOPPING_CATEGORY_ORDER.forEach(function (cat) { byCat[cat].sort(); });
    return byCat;
  }

  function renderShoppingRow(key, displayName, count, checkedMap) {
    var checked = !!checkedMap[key];
    var row = el('div', { class: 'card shopping-item' + (checked ? ' checked' : '') }, '');
    var checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = checked;
    checkbox.addEventListener('change', function () {
      checkedMap[key] = checkbox.checked;
      save();
      row.classList.toggle('checked', checkbox.checked);
    });
    var labelText = displayName + (count > 1 ? ' ×' + count : '');
    var label = el('div', { class: 'card-main' }, '<div class="card-title">' + escapeHtml(labelText) + '</div>');
    row.appendChild(checkbox);
    row.appendChild(label);
    shoppingListEl.appendChild(row);
  }
  // La liste affichee ne compte que les jours de la semaine visible qui ne sont pas
  // encore passes (aujourd'hui exclu) : pas la peine de racheter ce qui est deja mange.
  function renderShoppingList() {
    var weekKey = fmtISO(viewingMonday);
    shoppingListEl.innerHTML = '';
    var weekSunday = addDays(viewingMonday, 6);
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var rangeStart = addDays(today, 1);
    if (rangeStart.getTime() < viewingMonday.getTime()) rangeStart = viewingMonday;
    if (rangeStart.getTime() > weekSunday.getTime()) {
      shoppingRangeNoteEl.textContent = '';
      shoppingListEl.appendChild(el('div', { class: 'empty-hint' }, "Tous les jours de cette semaine sont déjà passés (ou c'est aujourd'hui) — rien à acheter pour l'instant."));
      return;
    }
    shoppingRangeNoteEl.textContent = 'Repas des prochains jours uniquement (les jours déjà passés, et aujourd\'hui, ne sont pas comptés) — du ' + fmtLong(rangeStart) + ' au ' + fmtLong(weekSunday) + '.';
    var counts = aggregateShoppingListRange(rangeStart, weekSunday, false);
    if (!Object.keys(counts).length) {
      shoppingListEl.appendChild(el('div', { class: 'empty-hint' }, "Aucun repas planifié pour les jours à venir cette semaine."));
      return;
    }
    if (!state.shoppingChecked[weekKey]) state.shoppingChecked[weekKey] = {};
    var checkedMap = state.shoppingChecked[weekKey];
    var byCat = categorizedKeys(counts);
    SHOPPING_CATEGORY_ORDER.forEach(function (cat) {
      if (!byCat[cat].length) return;
      shoppingListEl.appendChild(el('div', { class: 'muted' }, SHOPPING_CATEGORY_LABELS[cat]));
      byCat[cat].forEach(function (k) {
        renderShoppingRow(k, counts[k].displayName, counts[k].count, checkedMap);
      });
    });
  }

  // Emoji hors BMP (paires de substitution) + symboles emoji du BMP.
  // La plage des fleches (U+2190-21FF) est volontairement exclue pour ne pas
  // manger le « → » du libelle de semaine.
  var EMOJI_RE = /(?:[\uD800-\uDBFF][\uDC00-\uDFFF]|[\u2600-\u27BF\u2B00-\u2BFF\u3030\u303D])[\uFE0E\uFE0F]?/g;
  function stripEmojis(str) {
    return str.replace(EMOJI_RE, '').replace(/\s{2,}/g, ' ').replace(/^\s+|\s+$/g, '');
  }
  // Le texte d'origine est memorise sur le noeud lui-meme, pour pouvoir revenir
  // aux emoji si l'utilisateur rebascule le reglage.
  function walkTextNodes(node, fn) {
    if (node.nodeType === 3) { fn(node); return; }
    if (node.nodeType !== 1) return;
    if (node.getAttribute && node.getAttribute('data-icon')) return; // traite a part
    for (var i = 0; i < node.childNodes.length; i++) walkTextNodes(node.childNodes[i], fn);
  }
  // Remplace les emoji par du texte lisible quand le navigateur ne sait pas les
  // afficher. A rappeler apres chaque rendu, car le HTML d'origine revient.
  function applyIconMode() {
    var textMode = useTextIcons();
    var ICON_LABELS = {
      edit: { text: 'Modif.', emoji: '✏️', cls: 'icon-btn' },
      'delete': { text: 'Suppr.', emoji: '🗑', cls: 'icon-btn' },
      close: { text: 'X', emoji: '✕', cls: 'modal-close-x' }
    };
    var iconBtns = document.querySelectorAll('[data-icon]');
    for (var b = 0; b < iconBtns.length; b++) {
      var spec = ICON_LABELS[iconBtns[b].getAttribute('data-icon')];
      if (!spec) continue;
      var wanted = textMode ? spec.text : spec.emoji;
      if (iconBtns[b].textContent !== wanted) iconBtns[b].textContent = wanted;
      iconBtns[b].className = (textMode && spec.cls === 'icon-btn') ? 'icon-btn icon-btn-text' : spec.cls;
    }
    walkTextNodes(document.getElementById('app'), function (node) {
      if (textMode) {
        if (node.origText === undefined) node.origText = node.nodeValue;
        var cleaned = stripEmojis(node.origText);
        if (cleaned !== node.nodeValue) node.nodeValue = cleaned;
      } else if (node.origText !== undefined && node.nodeValue !== node.origText) {
        node.nodeValue = node.origText;
      }
    });
  }

  function renderAll() {
    renderWeekLabel();
    renderPlanningGrid();
    renderMealList();
    renderIngredientList();
    renderShoppingList();
    applyIconMode();
  }

  /* ---------------------------------------------------------------------
   * Export de la liste de courses (dates choisies librement, deja coche exclu)
   * ------------------------------------------------------------------- */
  function parseDateInput(str) {
    var p = str.split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
  }

  function buildShoppingListText(counts, startDate, endDate) {
    var lines = [];
    lines.push('Liste de courses');
    lines.push('Du ' + fmtLong(startDate) + ' au ' + fmtLong(endDate));
    lines.push('');
    if (!Object.keys(counts).length) {
      lines.push('(Rien à acheter : tout est déjà coché, ou aucun repas planifié sur cette période.)');
    } else {
      var byCat = categorizedKeys(counts);
      SHOPPING_CATEGORY_ORDER.forEach(function (cat) {
        if (!byCat[cat].length) return;
        lines.push(SHOPPING_CATEGORY_LABELS[cat]);
        byCat[cat].forEach(function (k) {
          var item = counts[k];
          lines.push('- ' + item.displayName + (item.count > 1 ? '  x' + item.count : ''));
        });
        lines.push('');
      });
    }
    return lines.join('\n');
  }

  function csvEscape(v) {
    v = String(v);
    if (v.indexOf(',') !== -1 || v.indexOf('"') !== -1 || v.indexOf('\n') !== -1) {
      v = '"' + v.replace(/"/g, '""') + '"';
    }
    return v;
  }
  function buildShoppingListCsv(counts, startDate, endDate) {
    var rows = [];
    rows.push(['Liste de courses', 'Du ' + fmtLong(startDate) + ' au ' + fmtLong(endDate)]);
    rows.push([]);
    rows.push(['Catégorie', 'Ingrédient', 'Quantité']);
    var byCat = categorizedKeys(counts);
    SHOPPING_CATEGORY_ORDER.forEach(function (cat) {
      byCat[cat].forEach(function (k) {
        var item = counts[k];
        rows.push([SHOPPING_CATEGORY_LABELS[cat], item.displayName, 'x' + item.count]);
      });
    });
    var lines = rows.map(function (r) { return r.map(csvEscape).join(','); });
    return '﻿' + lines.join('\r\n');
  }

  function downloadFile(filename, content, mimeType) {
    var blob = new Blob([content], { type: mimeType });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  function openShoppingExportModal() {
    var wrap = document.createElement('div');
    var today = new Date();
    today.setHours(0, 0, 0, 0);
    var defaultStart = addDays(today, 1);
    var defaultEnd = addDays(defaultStart, 6);
    var html = '';
    html += '<h3>Télécharger la liste de courses</h3>';
    html += '<div class="field"><label>Du</label><input type="date" id="f-export-start" value="' + fmtISO(defaultStart) + '" /></div>';
    html += '<div class="field"><label>Au</label><input type="date" id="f-export-end" value="' + fmtISO(defaultEnd) + '" /></div>';
    html += '<div class="field"><label>Format</label>';
    html += '<div class="modal-actions-top" id="f-export-actions"></div></div>';
    html += '<div class="card-sub">Les articles déjà cochés ne sont pas inclus.</div>';
    wrap.innerHTML = html;

    var startInput = wrap.querySelector('#f-export-start');
    var endInput = wrap.querySelector('#f-export-end');
    var actions = wrap.querySelector('#f-export-actions');

    function getRange() {
      var start = parseDateInput(startInput.value);
      var end = parseDateInput(endInput.value);
      if (end.getTime() < start.getTime()) { alert('La date de fin doit être après la date de début.'); return null; }
      return { start: start, end: end };
    }
    function baseFilename(ext, start) { return 'liste-de-courses-' + fmtISO(start) + '.' + ext; }

    var docsBtn = el('button', { class: 'btn-secondary' }, '📄 Texte (Google Docs)');
    docsBtn.addEventListener('click', function () {
      var range = getRange();
      if (!range) return;
      var counts = aggregateShoppingListRange(range.start, range.end, true);
      downloadFile(baseFilename('txt', range.start), buildShoppingListText(counts, range.start, range.end), 'text/plain;charset=utf-8');
    });
    var sheetsBtn = el('button', { class: 'btn-secondary' }, '📊 CSV (Google Sheets)');
    sheetsBtn.addEventListener('click', function () {
      var range = getRange();
      if (!range) return;
      var counts = aggregateShoppingListRange(range.start, range.end, true);
      downloadFile(baseFilename('csv', range.start), buildShoppingListCsv(counts, range.start, range.end), 'text/csv;charset=utf-8');
    });
    var keepBtn = el('button', { class: 'btn-secondary' }, '📝 Texte (Google Keep)');
    keepBtn.addEventListener('click', function () {
      var range = getRange();
      if (!range) return;
      var counts = aggregateShoppingListRange(range.start, range.end, true);
      downloadFile(baseFilename('txt', range.start), buildShoppingListText(counts, range.start, range.end), 'text/plain;charset=utf-8');
    });
    actions.appendChild(docsBtn);
    actions.appendChild(sheetsBtn);
    actions.appendChild(keepBtn);

    openModalWith(wrap);
  }

  /* ---------------------------------------------------------------------
   * Modals
   * ------------------------------------------------------------------- */
  function closeModal() { modalRoot.innerHTML = ''; }
  function openModalWith(innerNode) {
    var backdrop = el('div', { class: 'modal-backdrop' }, '');
    var modal = el('div', { class: 'modal' }, '');
    var closeX = el('button', { class: 'modal-close-x', 'aria-label': 'Fermer', 'data-icon': 'close' }, '✕');
    closeX.addEventListener('click', function () { pendingSlotContext = null; closeModal(); });
    var scrollWrap = el('div', { class: 'modal-scroll' }, '');
    scrollWrap.appendChild(innerNode);
    modal.appendChild(closeX);
    modal.appendChild(scrollWrap);
    backdrop.appendChild(modal);
    // Filet de securite : un clic sur le fond dans les tout premiers instants
    // vient forcement de l'evenement fantome du geste qui a ouvert la fenetre.
    var openedAt = Date.now();
    backdrop.addEventListener('click', function (e) {
      if (e.target !== backdrop) return;
      if (Date.now() - openedAt < 600) return;
      pendingSlotContext = null;
      closeModal();
    });
    modalRoot.innerHTML = '';
    modalRoot.appendChild(backdrop);
    applyIconMode();
  }

  var pendingSlotContext = null; // {weekKey, key} : assigne aussi le resultat a cette case

  function openMealModal(opts) {
    var mode = opts.mode, meal = opts.meal;
    var isEdit = mode === 'edit';
    var wrap = document.createElement('div');
    var ingredientsValue = isEdit ? meal.ingredients.map(function (i) { return escapeHtml(i.name); }).join('\n') : '';
    var html = '';
    html += '<h3>' + (isEdit ? 'Modifier le repas' : 'Nouveau repas') + '</h3>';
    html += '<div class="field"><label>Nom du plat</label>';
    html += '<input type="text" id="f-name" value="' + (isEdit ? escapeHtml(meal.name) : '') + '" /></div>';
    html += '<div class="field"><label>Ingrédients (un par ligne)</label>';
    html += '<textarea id="f-ingredients">' + ingredientsValue + '</textarea></div>';
    html += '<div class="field"><label>Tags nutrition</label>';
    html += '<div class="checkbox-row"><input type="checkbox" id="f-protein" ' + (isEdit && meal.tags.protein ? 'checked' : '') + '/><label for="f-protein">Contient une protéine (viande / poisson / œuf)</label></div>';
    html += '<div class="checkbox-row"><input type="checkbox" id="f-starch" ' + (isEdit && meal.tags.starch ? 'checked' : '') + '/><label for="f-starch">Contient un féculent</label></div>';
    html += '<div class="checkbox-row"><input type="checkbox" id="f-veg" ' + (isEdit && meal.tags.veg ? 'checked' : '') + '/><label for="f-veg">Contient des légumes</label></div>';
    html += '</div>';
    html += '<div class="field"><label>Recette (étapes de préparation)</label>';
    html += '<textarea id="f-recipe" placeholder="Étape 1 : ...">' + (isEdit && meal.recipe ? escapeHtml(meal.recipe) : '') + '</textarea></div>';

    var excludedSlots = (isEdit && meal.excludedSlots) ? meal.excludedSlots : [];
    html += '<div class="field">';
    html += '<button type="button" class="btn-secondary" id="f-avoid-toggle">🚫 Jours à éviter (' + excludedSlots.length + ')</button>';
    html += '<div id="f-avoid-days" style="display:none; margin-top:10px;">';
    for (var adi = 0; adi < DAY_NAMES.length; adi++) {
      html += '<div class="avoid-day-row"><span class="avoid-day-name">' + DAY_NAMES[adi] + '</span>';
      MEAL_SLOTS.forEach(function (s) {
        var k = slotKey(adi, s);
        var checked = excludedSlots.indexOf(k) !== -1 ? 'checked' : '';
        html += '<label class="avoid-slot-label"><input type="checkbox" class="f-avoid-check" data-key="' + k + '" ' + checked + '/>' + SLOT_LABELS[s] + '</label>';
      });
      html += '</div>';
    }
    html += '</div></div>';

    html += '<div class="modal-actions" id="f-actions"></div>';
    wrap.innerHTML = html;

    var avoidToggle = wrap.querySelector('#f-avoid-toggle');
    var avoidDaysEl = wrap.querySelector('#f-avoid-days');
    function updateAvoidToggleLabel() {
      var count = wrap.querySelectorAll('.f-avoid-check:checked').length;
      avoidToggle.textContent = '🚫 Jours à éviter (' + count + ')';
    }
    avoidToggle.addEventListener('click', function () {
      avoidDaysEl.style.display = avoidDaysEl.style.display === 'none' ? 'block' : 'none';
    });
    var avoidChecks = wrap.querySelectorAll('.f-avoid-check');
    for (var aci = 0; aci < avoidChecks.length; aci++) {
      avoidChecks[aci].addEventListener('change', updateAvoidToggleLabel);
    }

    var actions = wrap.querySelector('#f-actions');
    if (isEdit) {
      var delBtn = el('button', { class: 'btn-danger' }, 'Supprimer');
      delBtn.addEventListener('click', function () {
        if (confirm('Supprimer "' + meal.name + '" ?')) {
          removeMealEverywhere(meal.id);
          save();
          closeModal();
          renderMealList();
          renderPlanningGrid();
        }
      });
      actions.appendChild(delBtn);
    }
    var cancelBtn = el('button', { class: 'btn-ghost' }, 'Annuler');
    cancelBtn.addEventListener('click', function () { pendingSlotContext = null; closeModal(); });
    var saveBtn = el('button', { class: 'btn-primary' }, 'Enregistrer');
    saveBtn.addEventListener('click', function () {
      var name = wrap.querySelector('#f-name').value.replace(/^\s+|\s+$/g, '');
      if (!name) { alert('Le nom du plat est obligatoire.'); return; }
      var warnings = duplicateWarnings(name, isEdit ? meal.id : null, pendingSlotContext);
      if (warnings.length && !confirm(warnings.join('\n') + '\n\nContinuer quand même ?')) return;
      var ingredientsText = wrap.querySelector('#f-ingredients').value;
      var ingredients = ingredientsText.split('\n')
        .map(function (s) { return s.replace(/^\s+|\s+$/g, ''); })
        .filter(function (s) { return s; })
        .map(function (n) { return { name: n, ingredientId: null, category: null }; });
      var tags = {
        protein: wrap.querySelector('#f-protein').checked,
        starch: wrap.querySelector('#f-starch').checked,
        veg: wrap.querySelector('#f-veg').checked
      };
      var recipe = wrap.querySelector('#f-recipe').value.replace(/^\s+|\s+$/g, '');
      var newExcludedSlots = [];
      var checkedAvoids = wrap.querySelectorAll('.f-avoid-check:checked');
      for (var eai = 0; eai < checkedAvoids.length; eai++) newExcludedSlots.push(checkedAvoids[eai].getAttribute('data-key'));
      var savedMeal;
      if (isEdit) {
        meal.name = name;
        meal.ingredients = ingredients;
        meal.tags = tags;
        meal.recipe = recipe;
        meal.excludedSlots = newExcludedSlots;
        savedMeal = meal;
      } else {
        savedMeal = { id: uid(), name: name, ingredients: ingredients, tags: tags, recipe: recipe, excludedSlots: newExcludedSlots, source: 'manual', usageCount: 0, lastUsedWeekKey: null, history: [] };
        state.meals.push(savedMeal);
      }
      if (pendingSlotContext) {
        assignSlot(pendingSlotContext.weekKey, pendingSlotContext.key, savedMeal.id);
        pendingSlotContext = null;
      }
      save();
      closeModal();
      renderMealList();
      renderPlanningGrid();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    openModalWith(wrap);
  }

  function openRecipeView(meal, slotContext) {
    var wrap = document.createElement('div');
    var ingredientsLine = meal.ingredients.length ? meal.ingredients.map(function (i) { return escapeHtml(i.name); }).join(', ') : '—';
    var recipeHtml = meal.recipe ? escapeHtml(meal.recipe) : '<span class="muted">Aucune recette renseignée pour le moment.</span>';
    var html = '';
    html += '<h3>' + escapeHtml(meal.name) + '</h3>';
    html += '<div class="field"><div class="card-sub">' + tagBadges(meal.tags) + '</div></div>';
    html += '<div class="field"><label>Ingrédients</label><div class="card-sub">' + ingredientsLine + '</div></div>';
    html += '<div class="field"><label>Recette</label><div class="recipe-text">' + recipeHtml + '</div></div>';
    html += '<div class="modal-actions" id="f-recipe-actions"></div>';
    wrap.innerHTML = html;

    var actions = wrap.querySelector('#f-recipe-actions');
    var editBtn = el('button', { class: 'btn-secondary' }, '✏️ Modifier');
    editBtn.addEventListener('click', function () { openMealModal({ mode: 'edit', meal: meal }); });
    actions.appendChild(editBtn);
    if (slotContext) {
      var changeBtn = el('button', { class: 'btn-secondary' }, '🔁 Changer de repas');
      changeBtn.addEventListener('click', function () { openMealPicker(slotContext.dayIndex, slotContext.slot); });
      actions.appendChild(changeBtn);
    }

    openModalWith(wrap);
  }

  function openIngredientModal(opts) {
    var mode = opts.mode, ingredient = opts.ingredient;
    var isEdit = mode === 'edit';
    var wrap = document.createElement('div');
    var optionsHtml = '';
    for (var oi = 0; oi < CATEGORY_ORDER.length; oi++) {
      var c = CATEGORY_ORDER[oi];
      optionsHtml += '<option value="' + c + '" ' + (isEdit && ingredient.category === c ? 'selected' : '') + '>' + CATEGORY_LABELS[c] + '</option>';
    }
    var html = '';
    html += '<h3>' + (isEdit ? "Modifier l'ingrédient" : 'Nouvel ingrédient') + '</h3>';
    html += '<div class="field"><label>Nom</label>';
    html += '<input type="text" id="f-iname" value="' + (isEdit ? escapeHtml(ingredient.name) : '') + '" /></div>';
    html += '<div class="field"><label>Catégorie</label><select id="f-icat">' + optionsHtml + '</select></div>';
    html += '<div class="modal-actions" id="f-iactions"></div>';
    wrap.innerHTML = html;

    var actions = wrap.querySelector('#f-iactions');
    if (isEdit) {
      var delBtn = el('button', { class: 'btn-danger' }, 'Supprimer');
      delBtn.addEventListener('click', function () {
        if (confirm('Supprimer "' + ingredient.name + '" ?')) {
          state.ingredients = state.ingredients.filter(function (i) { return i.id !== ingredient.id; });
          save();
          closeModal();
          renderIngredientList();
        }
      });
      actions.appendChild(delBtn);
    }
    var cancelBtn = el('button', { class: 'btn-ghost' }, 'Annuler');
    cancelBtn.addEventListener('click', closeModal);
    var saveBtn = el('button', { class: 'btn-primary' }, 'Enregistrer');
    saveBtn.addEventListener('click', function () {
      var name = wrap.querySelector('#f-iname').value.replace(/^\s+|\s+$/g, '');
      if (!name) { alert("Le nom de l'ingrédient est obligatoire."); return; }
      var category = wrap.querySelector('#f-icat').value;
      if (isEdit) {
        ingredient.name = name;
        ingredient.category = category;
      } else {
        state.ingredients.push({ id: uid(), name: name, category: category });
      }
      save();
      closeModal();
      renderIngredientList();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(saveBtn);
    openModalWith(wrap);
  }

  function buildMealNameFromSelection(selected) {
    var byCat = { protein: [], starch: [], vegetable: [], dairy: [], sauce: [] };
    selected.forEach(function (i) { if (byCat[i.category]) byCat[i.category].push(i.name); });
    var mainParts = [];
    if (byCat.protein.length) mainParts.push(byCat.protein.join(' et '));
    if (byCat.starch.length) mainParts.push(byCat.starch.join(' et '));
    var name = mainParts.join(' avec ');
    var extras = byCat.vegetable.concat(byCat.dairy).concat(byCat.sauce);
    if (extras.length) name += (name ? ' et ' : '') + extras.join(', ');
    if (!name) name = selected.map(function (i) { return i.name; }).join(', ');
    return name;
  }

  function openIngredientSelectModal() {
    if (!state.ingredients.length) {
      alert("Ajoute d'abord des ingrédients dans l'onglet Ingrédients pour pouvoir créer un repas à partir d'ingrédients sélectionnés.");
      return;
    }
    var wrap = document.createElement('div');
    var html = '';
    html += '<h3>Créer un repas depuis des ingrédients</h3>';
    html += '<div class="field"><label>Sélectionne les ingrédients du plat</label>';
    html += '<div id="f-ing-checklist">';
    for (var ci = 0; ci < CATEGORY_ORDER.length; ci++) {
      var cat = CATEGORY_ORDER[ci];
      var items = state.ingredients.filter(function (i) { return i.category === cat; });
      if (!items.length) continue;
      html += '<div class="muted">' + CATEGORY_LABELS[cat] + '</div>';
      items.sort(function (a, b) { return a.name.localeCompare(b.name); });
      for (var ii = 0; ii < items.length; ii++) {
        html += '<div class="checkbox-row"><input type="checkbox" class="f-ing-check" data-id="' + items[ii].id + '" id="f-ing-' + items[ii].id + '"/><label for="f-ing-' + items[ii].id + '">' + escapeHtml(items[ii].name) + '</label></div>';
      }
    }
    html += '</div></div>';
    html += '<div class="field"><label>Nom du plat (modifiable)</label><input type="text" id="f-gen-name" value="" /></div>';
    html += '<div class="modal-actions" id="f-gen-actions"></div>';
    wrap.innerHTML = html;

    var nameInput = wrap.querySelector('#f-gen-name');
    var nameEditedByUser = false;
    nameInput.addEventListener('input', function () { nameEditedByUser = true; });

    function getSelectedIngredients() {
      var checks = wrap.querySelectorAll('.f-ing-check');
      var selected = [];
      for (var i = 0; i < checks.length; i++) {
        if (checks[i].checked) {
          var ing = arrFind(state.ingredients, function (x) { return x.id === checks[i].getAttribute('data-id'); });
          if (ing) selected.push(ing);
        }
      }
      return selected;
    }
    function refreshSuggestedName() {
      if (nameEditedByUser) return;
      var selected = getSelectedIngredients();
      nameInput.value = selected.length ? buildMealNameFromSelection(selected) : '';
    }
    var allChecks = wrap.querySelectorAll('.f-ing-check');
    for (var chi = 0; chi < allChecks.length; chi++) {
      allChecks[chi].addEventListener('change', refreshSuggestedName);
    }

    var actions = wrap.querySelector('#f-gen-actions');
    var cancelBtn = el('button', { class: 'btn-ghost' }, 'Annuler');
    cancelBtn.addEventListener('click', function () { pendingSlotContext = null; closeModal(); });
    var createBtn = el('button', { class: 'btn-primary' }, 'Créer ce repas');
    createBtn.addEventListener('click', function () {
      var selected = getSelectedIngredients();
      if (!selected.length) { alert('Sélectionne au moins un ingrédient.'); return; }
      var name = nameInput.value.replace(/^\s+|\s+$/g, '') || buildMealNameFromSelection(selected);
      var warnings = duplicateWarnings(name, null, pendingSlotContext);
      if (warnings.length && !confirm(warnings.join('\n') + '\n\nContinuer quand même ?')) return;
      var tags = {
        protein: selected.some(function (i) { return i.category === 'protein'; }),
        starch: selected.some(function (i) { return i.category === 'starch'; }),
        veg: selected.some(function (i) { return i.category === 'vegetable'; })
      };
      var savedMeal = {
        id: uid(), name: name,
        ingredients: selected.map(function (i) { return { name: i.name, ingredientId: i.id, category: i.category }; }),
        tags: tags, recipe: '', excludedSlots: [], source: 'generated', usageCount: 0, lastUsedWeekKey: null, history: []
      };
      state.meals.push(savedMeal);
      if (pendingSlotContext) {
        assignSlot(pendingSlotContext.weekKey, pendingSlotContext.key, savedMeal.id);
        pendingSlotContext = null;
      }
      save();
      closeModal();
      renderMealList();
      renderPlanningGrid();
      if (currentTab === 'shopping') renderShoppingList();
    });
    actions.appendChild(cancelBtn);
    actions.appendChild(createBtn);
    openModalWith(wrap);
  }

  function openMealPicker(dayIndex, slot) {
    var weekKey = fmtISO(viewingMonday);
    var key = slotKey(dayIndex, slot);
    var currentMealId = state.plan[weekKey] ? state.plan[weekKey][key] : null;

    var wrap = document.createElement('div');
    var dayDate = addDays(viewingMonday, dayIndex);
    var html = '';
    html += '<h3>' + DAY_NAMES[dayIndex] + ' ' + fmtLong(dayDate) + ' — ' + SLOT_LABELS[slot] + '</h3>';
    html += '<div class="modal-actions-top" id="f-picker-actions"></div>';
    html += '<div id="f-generate-zone"></div>';
    html += '<div class="field search-box"><input type="text" id="f-search" placeholder="Rechercher un repas..." /></div>';
    html += '<div class="meal-picker-list" id="f-list"></div>';
    wrap.innerHTML = html;

    var listEl = wrap.querySelector('#f-list');
    var searchEl = wrap.querySelector('#f-search');

    function renderList(filter) {
      listEl.innerHTML = '';
      var items = state.meals.filter(function (m) { return mealMatchesQuery(m, filter || ''); })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (!items.length) {
        listEl.appendChild(el('div', { class: 'empty-hint' }, 'Aucun repas trouvé.'));
        return;
      }
      items.forEach(function (meal) {
        var item = el('div', { class: 'meal-picker-item' }, '<span>' + escapeHtml(meal.name) + ' ' + tagIcons(meal) + '</span>');
        item.addEventListener('click', function () {
          if (mealNameUsedElsewhereInWeek(meal.name, weekKey, key) &&
            !confirm('"' + meal.name + '" est déjà prévu ailleurs cette semaine.\n\nContinuer quand même ?')) return;
          assignSlot(weekKey, key, meal.id);
          save();
          closeModal();
          renderPlanningGrid();
          if (currentTab === 'shopping') renderShoppingList();
        });
        listEl.appendChild(item);
      });
    }
    renderList('');
    searchEl.addEventListener('input', function () { renderList(searchEl.value); });

    var genZone = wrap.querySelector('#f-generate-zone');
    function showGeneratedPreview() {
      if (!ingredientsPoolViable()) {
        genZone.innerHTML = '<div class="empty-hint">Ajoute au moins une protéine et un féculent dans l\'onglet Ingrédients pour pouvoir générer un repas.</div>';
        return;
      }
      var avoidProteins = recentTypesBefore(weekKey, dayIndex, slot, 2, 'protein').map(function (r) { return r.type; });
      var avoidStarches = recentTypesBefore(weekKey, dayIndex, slot, 2, 'starch').map(function (r) { return r.type; });
      var preview = generateMealFromIngredients(avoidProteins, avoidStarches);
      genZone.innerHTML = '';
      var card = el('div', { class: 'card' }, '<div class="card-main"><div class="card-title">' + escapeHtml(preview.name) + '</div><div class="card-sub">' + tagBadges(preview.tags) + '</div></div>');
      genZone.appendChild(card);
      var btnRow = el('div', { class: 'modal-actions' }, '');
      var useBtn = el('button', { class: 'btn-primary' }, '✅ Utiliser ce repas');
      useBtn.addEventListener('click', function () {
        if (mealNameUsedElsewhereInWeek(preview.name, weekKey, key) &&
          !confirm('"' + preview.name + '" est déjà prévu ailleurs cette semaine.\n\nContinuer quand même ?')) return;
        state.meals.push(preview);
        assignSlot(weekKey, key, preview.id);
        save();
        closeModal();
        renderPlanningGrid();
        renderMealList();
        if (currentTab === 'shopping') renderShoppingList();
      });
      var rerollBtn = el('button', { class: 'btn-secondary' }, '🔁 Une autre idée');
      rerollBtn.addEventListener('click', showGeneratedPreview);
      btnRow.appendChild(rerollBtn);
      btnRow.appendChild(useBtn);
      genZone.appendChild(btnRow);
    }

    var actions = wrap.querySelector('#f-picker-actions');
    var generateBtn = el('button', { class: 'btn-secondary' }, '🎲 Générer depuis les ingrédients');
    generateBtn.addEventListener('click', showGeneratedPreview);
    var selectIngBtn = el('button', { class: 'btn-secondary' }, '🥕 Choisir des ingrédients');
    selectIngBtn.addEventListener('click', function () {
      pendingSlotContext = { weekKey: weekKey, key: key };
      openIngredientSelectModal();
    });
    var newMealBtn = el('button', { class: 'btn-secondary' }, '➕ Nouveau repas manuel');
    newMealBtn.addEventListener('click', function () {
      pendingSlotContext = { weekKey: weekKey, key: key };
      openMealModal({ mode: 'add' });
    });
    var clearBtn = el('button', { class: 'btn-ghost' }, '🗑 Vider cette case');
    clearBtn.addEventListener('click', function () {
      unassignSlot(weekKey, key);
      save();
      closeModal();
      renderPlanningGrid();
      if (currentTab === 'shopping') renderShoppingList();
    });
    actions.appendChild(generateBtn);
    actions.appendChild(selectIngBtn);
    actions.appendChild(newMealBtn);
    if (currentMealId) actions.appendChild(clearBtn);

    openModalWith(wrap);
  }

  /* ---------------------------------------------------------------------
   * Planning grid interactions: tap / long-press-drag-swap / swipe weeks
   * Implementees avec des evenements touch + mouse classiques (pas de
   * Pointer Events, non supportes sur les vieux navigateurs Android).
   * ------------------------------------------------------------------- */
  var gestureState = null;
  var ghostEl = null;
  var lastTouchTime = 0;

  function closestSlot(node) {
    while (node && node !== gridEl && node !== document.body) {
      if (node.classList && node.classList.contains('meal-slot')) return node;
      node = node.parentNode;
    }
    return null;
  }
  function clearGhost() {
    if (ghostEl && ghostEl.parentNode) ghostEl.parentNode.removeChild(ghostEl);
    ghostEl = null;
  }
  function clearDragHighlight() {
    var marked = gridEl.querySelectorAll('.drag-over');
    for (var i = 0; i < marked.length; i++) marked[i].classList.remove('drag-over');
  }

  // Seuils volontairement genereux : sur un vieil ecran tactile, un simple appui
  // bouge souvent de quelques pixels et dure facilement plus de 350 ms.
  var MOVE_THRESHOLD = 14;
  var LONG_PRESS_MS = 550;

  function openSlot(dayIndex, slot) {
    var weekKey = fmtISO(viewingMonday);
    var key = slotKey(dayIndex, slot);
    var mealId = state.plan[weekKey] ? state.plan[weekKey][key] : null;
    var meal = mealId ? arrFind(state.meals, function (m) { return m.id === mealId; }) : null;
    if (meal) {
      openRecipeView(meal, { weekKey: weekKey, key: key, dayIndex: dayIndex, slot: slot });
    } else {
      openMealPicker(dayIndex, slot);
    }
  }
  function openSlotFromEl(slotEl) {
    openSlot(Number(slotEl.getAttribute('data-day')), slotEl.getAttribute('data-slot'));
  }

  function gestureStart(clientX, clientY, targetNode) {
    var slotEl = closestSlot(targetNode);
    gestureState = {
      startX: clientX, startY: clientY, startTime: Date.now(),
      slotEl: slotEl, dragMode: false, moved: false, timer: null
    };
    if (slotEl) {
      gestureState.timer = setTimeout(function () {
        if (!gestureState) return;
        gestureState.dragMode = true;
        slotEl.classList.add('dragging');
        ghostEl = slotEl.cloneNode(true);
        ghostEl.classList.remove('dragging');
        ghostEl.style.position = 'fixed';
        ghostEl.style.width = slotEl.offsetWidth + 'px';
        ghostEl.style.pointerEvents = 'none';
        ghostEl.style.zIndex = '999';
        ghostEl.style.opacity = '0.85';
        ghostEl.style.left = (clientX - slotEl.offsetWidth / 2) + 'px';
        ghostEl.style.top = (clientY - 20) + 'px';
        document.body.appendChild(ghostEl);
      }, LONG_PRESS_MS);
    }
  }
  function gestureMove(clientX, clientY) {
    if (!gestureState) return;
    var dx = clientX - gestureState.startX;
    var dy = clientY - gestureState.startY;
    if (Math.abs(dx) > MOVE_THRESHOLD || Math.abs(dy) > MOVE_THRESHOLD) gestureState.moved = true;
    if (!gestureState.dragMode) {
      if (gestureState.moved) clearTimeout(gestureState.timer);
      return;
    }
    if (ghostEl) {
      ghostEl.style.left = (clientX - ghostEl.offsetWidth / 2) + 'px';
      ghostEl.style.top = (clientY - 20) + 'px';
    }
    clearDragHighlight();
    var under = document.elementFromPoint(clientX, clientY);
    var targetSlot = closestSlot(under);
    if (targetSlot && targetSlot !== gestureState.slotEl) targetSlot.classList.add('drag-over');
  }
  function gestureEnd(clientX, clientY) {
    if (!gestureState) return;
    clearTimeout(gestureState.timer);
    var weekKey = fmtISO(viewingMonday);

    if (gestureState.dragMode) {
      var under = document.elementFromPoint(clientX, clientY);
      var targetSlot = closestSlot(under);
      var srcEl = gestureState.slotEl;
      var didSwap = false;
      if (targetSlot && targetSlot !== srcEl) {
        var srcKey = slotKey(srcEl.getAttribute('data-day'), srcEl.getAttribute('data-slot'));
        var dstKey = slotKey(targetSlot.getAttribute('data-day'), targetSlot.getAttribute('data-slot'));
        swapSlots(weekKey, srcKey, dstKey);
        save();
        renderPlanningGrid();
        if (currentTab === 'shopping') renderShoppingList();
        didSwap = true;
      }
      if (srcEl) srcEl.classList.remove('dragging');
      clearDragHighlight();
      clearGhost();
      // Appui long relache sur place, sans deplacement : l'utilisateur voulait
      // simplement ouvrir la case, pas deplacer le repas.
      if (!didSwap && !gestureState.moved && srcEl) {
        gestureState = null;
        openSlotFromEl(srcEl);
        return;
      }
    } else {
      var dx = clientX - gestureState.startX;
      var dy = clientY - gestureState.startY;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        navigateWeek(dx > 0 ? -1 : 1);
      } else if (gestureState.slotEl && !gestureState.moved) {
        var tapEl = gestureState.slotEl;
        gestureState = null;
        openSlotFromEl(tapEl);
        return;
      }
    }
    gestureState = null;
  }
  function gestureCancel() {
    if (gestureState && gestureState.timer) clearTimeout(gestureState.timer);
    if (gestureState && gestureState.slotEl) gestureState.slotEl.classList.remove('dragging');
    clearDragHighlight();
    clearGhost();
    gestureState = null;
  }

  gridEl.addEventListener('touchstart', function (e) {
    lastTouchTime = Date.now();
    var t = e.touches[0];
    gestureStart(t.clientX, t.clientY, e.target);
  }, false);
  gridEl.addEventListener('touchmove', function (e) {
    var t = e.touches[0];
    if (t) gestureMove(t.clientX, t.clientY);
  }, false);
  gridEl.addEventListener('touchend', function (e) {
    var t = e.changedTouches[0];
    if (t) gestureEnd(t.clientX, t.clientY);
    // Empeche les evenements souris synthetiques emis ~300 ms plus tard par les
    // vieux navigateurs Android : ils retombaient sur le fond de la fenetre qui
    // venait de s'ouvrir et la refermaient aussitot.
    if (e.cancelable) e.preventDefault();
  }, false);
  gridEl.addEventListener('touchcancel', function () { gestureCancel(); }, false);

  var docMouseMove = function (e) { gestureMove(e.clientX, e.clientY); };
  var docMouseUp = function (e) {
    gestureEnd(e.clientX, e.clientY);
    document.removeEventListener('mousemove', docMouseMove, false);
    document.removeEventListener('mouseup', docMouseUp, false);
  };
  gridEl.addEventListener('mousedown', function (e) {
    if (Date.now() - lastTouchTime < 800) return; // ignore les faux evenements souris apres un touch
    gestureStart(e.clientX, e.clientY, e.target);
    document.addEventListener('mousemove', docMouseMove, false);
    document.addEventListener('mouseup', docMouseUp, false);
  }, false);

  function navigateWeek(delta) {
    viewingMonday = addDays(viewingMonday, delta * 7);
    renderWeekLabel();
    renderPlanningGrid();
    if (currentTab === 'shopping') renderShoppingList();
  }

  $('#btn-prev-week').addEventListener('click', function () { navigateWeek(-1); });
  $('#btn-next-week').addEventListener('click', function () { navigateWeek(1); });

  /* ---------------------------------------------------------------------
   * Planning actions
   * ------------------------------------------------------------------- */
  $('#btn-fill-week').addEventListener('click', function () {
    autofillWeek(fmtISO(viewingMonday), { onlyEmpty: true });
    renderPlanningGrid();
    renderMealList();
    if (currentTab === 'shopping') renderShoppingList();
  });
  $('#btn-repair-week').addEventListener('click', function () {
    var fixedCount = repairWeekClashes(fmtISO(viewingMonday));
    renderPlanningGrid();
    renderMealList();
    if (currentTab === 'shopping') renderShoppingList();
    alert(fixedCount ? (fixedCount + ' repas réorganisé' + (fixedCount > 1 ? 's' : '') + ' pour éviter les répétitions.') : 'Aucune répétition trouvée cette semaine.');
  });
  $('#btn-clear-week').addEventListener('click', function () {
    if (!confirm('Vider tous les repas de cette semaine ?')) return;
    var weekKey = fmtISO(viewingMonday);
    for (var d = 0; d < 7; d++) {
      for (var si3 = 0; si3 < MEAL_SLOTS.length; si3++) unassignSlot(weekKey, slotKey(d, MEAL_SLOTS[si3]));
    }
    save();
    renderPlanningGrid();
    if (currentTab === 'shopping') renderShoppingList();
  });

  /* ---------------------------------------------------------------------
   * Library / ingredient "add" buttons
   * ------------------------------------------------------------------- */
  $('#btn-add-meal').addEventListener('click', function () { pendingSlotContext = null; openMealModal({ mode: 'add' }); });
  $('#btn-create-from-ingredients').addEventListener('click', function () { pendingSlotContext = null; openIngredientSelectModal(); });
  $('#btn-add-ingredient').addEventListener('click', function () { openIngredientModal({ mode: 'add' }); });
  $('#btn-export-shopping').addEventListener('click', function () { openShoppingExportModal(); });

  /* ---------------------------------------------------------------------
   * Theme (sombre / clair)
   * ------------------------------------------------------------------- */
  function applyTheme() {
    var theme = (state.meta && state.meta.theme === 'light') ? 'light' : 'dark';
    var design = (state.meta && state.meta.design) || 'classic';
    if (design !== 'round' && design !== 'compact') design = 'classic';
    var classes = [];
    if (theme === 'light') classes.push('light');
    if (design === 'round') classes.push('design-round');
    if (design === 'compact') classes.push('design-compact');
    document.body.className = classes.join(' ');
    // met en evidence le bouton du theme et du design actifs
    themeDarkBtn.className = theme === 'dark' ? 'btn-primary' : 'btn-secondary';
    themeLightBtn.className = theme === 'light' ? 'btn-primary' : 'btn-secondary';
    designClassicBtn.className = design === 'classic' ? 'btn-primary' : 'btn-secondary';
    designRoundBtn.className = design === 'round' ? 'btn-primary' : 'btn-secondary';
    designCompactBtn.className = design === 'compact' ? 'btn-primary' : 'btn-secondary';
    var layout = (state.meta && state.meta.layout) || 'rows';
    if (layout !== 'columns' && layout !== 'list') layout = 'rows';
    layoutRowsBtn.className = layout === 'rows' ? 'btn-primary' : 'btn-secondary';
    layoutColumnsBtn.className = layout === 'columns' ? 'btn-primary' : 'btn-secondary';
    layoutListBtn.className = layout === 'list' ? 'btn-primary' : 'btn-secondary';
    var iconMode = (state.meta && state.meta.iconMode) || 'auto';
    if (iconMode !== 'emoji' && iconMode !== 'text') iconMode = 'auto';
    iconsAutoBtn.className = iconMode === 'auto' ? 'btn-primary' : 'btn-secondary';
    iconsEmojiBtn.className = iconMode === 'emoji' ? 'btn-primary' : 'btn-secondary';
    iconsTextBtn.className = iconMode === 'text' ? 'btn-primary' : 'btn-secondary';
  }
  function setThemePref(key, value) {
    state.meta[key] = value;
    save();
    if (key === 'iconMode') {
      // le HTML d'origine (avec emoji) doit etre regenere avant de re-substituer
      renderAll();
    }
    applyTheme();
    if (key === 'layout') renderPlanningGrid();
  }
  themeDarkBtn.addEventListener('click', function () { setThemePref('theme', 'dark'); });
  themeLightBtn.addEventListener('click', function () { setThemePref('theme', 'light'); });
  designClassicBtn.addEventListener('click', function () { setThemePref('design', 'classic'); });
  designRoundBtn.addEventListener('click', function () { setThemePref('design', 'round'); });
  designCompactBtn.addEventListener('click', function () { setThemePref('design', 'compact'); });
  layoutRowsBtn.addEventListener('click', function () { setThemePref('layout', 'rows'); });
  layoutColumnsBtn.addEventListener('click', function () { setThemePref('layout', 'columns'); });
  layoutListBtn.addEventListener('click', function () { setThemePref('layout', 'list'); });
  iconsAutoBtn.addEventListener('click', function () { setThemePref('iconMode', 'auto'); });
  iconsEmojiBtn.addEventListener('click', function () { setThemePref('iconMode', 'emoji'); });
  iconsTextBtn.addEventListener('click', function () { setThemePref('iconMode', 'text'); });
  $('#f-meal-search').addEventListener('input', function (e) { mealSearchQuery = e.target.value; renderMealList(); });

  /* ---------------------------------------------------------------------
   * Tabs
   * ------------------------------------------------------------------- */
  function selectTab(btn) {
    var view = btn.getAttribute('data-view');
    currentTab = view;
    var allTabs = document.querySelectorAll('.tab');
    for (var x = 0; x < allTabs.length; x++) allTabs[x].classList.toggle('active', allTabs[x] === btn);
    var allViews = document.querySelectorAll('.view');
    for (var y = 0; y < allViews.length; y++) allViews[y].classList.toggle('active', allViews[y].id === 'view-' + view);
    topbarEl.style.display = (view === 'planning' || view === 'shopping') ? '' : 'none';
    if (view === 'shopping') renderShoppingList();
    if (view === 'library') renderMealList();
    if (view === 'ingredients') renderIngredientList();
  }
  var tabButtons = document.querySelectorAll('.tab');
  for (var ti = 0; ti < tabButtons.length; ti++) {
    (function (btn) {
      btn.addEventListener('click', function () { selectTab(btn); });
    })(tabButtons[ti]);
  }

  /* ---------------------------------------------------------------------
   * Daily rollover: recentre on the current week + extend the horizon
   * ------------------------------------------------------------------- */
  function checkDailyRollover() {
    var today = fmtISO(new Date());
    if (state.meta.lastMaintainedDate !== today) {
      state.meta.lastMaintainedDate = today;
      viewingMonday = getMonday(new Date());
      maintainHorizon();
      save();
      renderAll();
    }
  }
  setInterval(checkDailyRollover, 60000);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) checkDailyRollover(); });

  /* ---------------------------------------------------------------------
   * Synchronisation cloud (connexion Google) : optionnelle, activee seulement si
   * firebase-sync.js a pu se charger (navigateur assez recent pour les modules ES).
   * Sur un vieux navigateur, window.MealPlannerSync n'existe jamais et tout ce bloc
   * reste inactif sans casser le reste de l'app.
   * ------------------------------------------------------------------- */
  function applyRemoteState(jsonString) {
    try {
      var parsed = JSON.parse(jsonString);
    } catch (e) { return; }
    receivingRemoteUpdate = true;
    state = mergeDefaults(defaultState(), parsed);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    receivingRemoteUpdate = false;
    renderAll();
    applyTheme();
  }
  function updateAuthUI(user) {
    if (user) {
      signInBtn.style.display = 'none';
      signOutBtn.style.display = '';
      authUserInfoEl.style.display = '';
      authSignedOutHintEl.style.display = 'none';
      authUserNameEl.textContent = user.displayName || user.email || 'Connecté';
    } else {
      signInBtn.style.display = '';
      signOutBtn.style.display = 'none';
      authUserInfoEl.style.display = 'none';
      authSignedOutHintEl.style.display = '';
    }
  }
  function initCloudSync() {
    if (!window.MealPlannerSync) return;
    syncUnavailableEl.style.display = 'none';
    signInBtn.style.display = '';
    authSignedOutHintEl.style.display = '';
    signInBtn.addEventListener('click', function () {
      window.MealPlannerSync.signIn().catch(function (err) { alert('Connexion Google impossible : ' + err.message); });
    });
    signOutBtn.addEventListener('click', function () { window.MealPlannerSync.signOut(); });
    window.MealPlannerSync.onAuthChange(function (user) {
      updateAuthUI(user);
      if (user) {
        window.MealPlannerSync.fetchOnce(user.uid).then(function (json) {
          if (json) {
            applyRemoteState(json);
          } else {
            window.MealPlannerSync.pushState(JSON.stringify(state));
          }
        });
      }
    });
    window.MealPlannerSync.onRemoteChange(function (json) {
      applyRemoteState(json);
    });
    window.MealPlannerSync.onStatusChange(function (msg) {
      authDebugEl.textContent = msg;
    });
  }
  if (window.MealPlannerSync) {
    initCloudSync();
  } else {
    window.addEventListener('mealplanner-sync-ready', initCloudSync);
  }

  /* ---------------------------------------------------------------------
   * Bootstrap
   * ------------------------------------------------------------------- */
  // Les listes se redessinent independamment (changement d'onglet, edition...) :
  // on rejoue la substitution d'icones apres chacune d'elles.
  (function wrapRendersWithIconMode() {
    var originals = {
      renderMealList: renderMealList,
      renderIngredientList: renderIngredientList,
      renderShoppingList: renderShoppingList
    };
    renderMealList = function () { originals.renderMealList(); applyIconMode(); };
    renderIngredientList = function () { originals.renderIngredientList(); applyIconMode(); };
    renderShoppingList = function () { originals.renderShoppingList(); applyIconMode(); };
  })();

  seedIfEmpty();
  state.meta.lastMaintainedDate = fmtISO(new Date());
  maintainHorizon();
  renderAll();
  applyTheme();

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
