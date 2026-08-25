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
    return { meals: [], ingredients: [], plan: {}, shoppingChecked: {}, meta: { lastMaintainedDate: null } };
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
  function save() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }

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
        tags: tags, source: 'manual', usageCount: 0, lastUsedWeekKey: null, history: []
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
  function generateMealFromIngredients() {
    var proteins = state.ingredients.filter(function (i) { return i.category === 'protein'; });
    var starches = state.ingredients.filter(function (i) { return i.category === 'starch'; });
    if (!proteins.length || !starches.length) return null;
    var vegetables = state.ingredients.filter(function (i) { return i.category === 'vegetable'; });
    var extras = state.ingredients.filter(function (i) { return i.category === 'dairy' || i.category === 'sauce'; });

    var protein = randPick(proteins);
    var starch = randPick(starches);
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
      source: 'generated',
      usageCount: 0,
      lastUsedWeekKey: null,
      history: []
    };
  }

  function chooseMealForSlot(weekKey, usedThisWeekIds, vegCountSoFar, filledSoFar) {
    var candidates = state.meals.filter(function (m) { return !usedThisWeekIds[m.id]; });
    var wantsGeneration = candidates.length === 0 || (Math.random() < GENERATION_CHANCE && ingredientsPoolViable());

    if (wantsGeneration) {
      var generated = generateMealFromIngredients();
      if (generated) {
        var dup = arrFind(state.meals, function (m) { return m.name === generated.name; });
        if (dup) {
          if (!usedThisWeekIds[dup.id]) return dup;
          // deja utilise cette semaine sous ce nom exact : on retombe sur le tirage normal
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
    function score(m) {
      var s = Math.min(weeksSince(m), 12);
      var currentRatio = vegCountSoFar / (filledSoFar || 1);
      if (m.tags.veg && currentRatio < TARGET_VEG_RATIO) s += 3;
      if (!m.tags.veg && currentRatio >= TARGET_VEG_RATIO) s -= 1;
      s += Math.random() * 1.5;
      return s;
    }
    var sorted = candidates.slice().sort(function (a, b) { return score(b) - score(a); });
    var top = sorted.slice(0, Math.min(3, sorted.length));
    return randPick(top);
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
    for (var idKey in usedThisWeekIds) {
      if (!Object.prototype.hasOwnProperty.call(usedThisWeekIds, idKey)) continue;
      var mm = arrFind(state.meals, function (x) { return x.id === idKey; });
      if (mm && mm.tags.veg) vegCountSoFar++;
    }

    for (var dayIndex = 0; dayIndex < 7; dayIndex++) {
      for (var si = 0; si < MEAL_SLOTS.length; si++) {
        var slot = MEAL_SLOTS[si];
        var key = slotKey(dayIndex, slot);
        if (opts.onlyEmpty && state.plan[weekKey][key]) continue;
        var meal = chooseMealForSlot(weekKey, usedThisWeekIds, vegCountSoFar, filledSoFar);
        if (!meal) continue;
        assignSlot(weekKey, key, meal.id);
        usedThisWeekIds[meal.id] = true;
        filledSoFar++;
        if (meal.tags.veg) vegCountSoFar++;
      }
    }
    save();
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
  var weekLabelEl = $('#week-label');
  var weekSublabelEl = $('#week-sublabel');
  var gridEl = $('#planning-grid');
  var mealListEl = $('#meal-list');
  var ingredientListEl = $('#ingredient-list');
  var shoppingListEl = $('#shopping-list');
  var modalRoot = $('#modal-root');

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

  function tagIcons(meal) {
    var out = '';
    if (meal.tags.protein) out += '🥩';
    if (meal.tags.starch) out += '🍝';
    if (meal.tags.veg) out += '🥦';
    return out;
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

  function renderPlanningGrid() {
    var weekKey = fmtISO(viewingMonday);
    var today = new Date();
    gridEl.innerHTML = '';

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
        var slot = MEAL_SLOTS[si2];
        var key = slotKey(dayIndex, slot);
        var mealId = state.plan[weekKey] ? state.plan[weekKey][key] : null;
        var meal = mealId ? arrFind(state.meals, function (m) { return m.id === mealId; }) : null;
        var cellClass = 'meal-slot grid-col-slot' + (isToday ? ' today-slot' : '') + (!meal ? ' empty' : '') + (meal && meal.source === 'generated' ? ' auto-badge' : '');
        var cellHtml = meal ? ('<div class="meal-name">' + escapeHtml(meal.name) + '</div><div class="meal-tags">' + tagIcons(meal) + '</div>') : '+ Ajouter';
        var cell = el('div', { class: cellClass, 'data-day': String(dayIndex), 'data-slot': slot }, cellHtml);
        row.appendChild(cell);
      }
      gridEl.appendChild(row);
    }
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
    var haystack = mealSearchHaystack(meal);
    return words.every(function (w) { return strContains(haystack, w); });
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
      var main = el('div', { class: 'card-main' },
        '<div class="card-title">' + escapeHtml(meal.name) + '</div>' +
        '<div class="card-sub">' + tagBadges(meal.tags) + '</div>' +
        '<div class="card-sub">' + ingredientsLine + '</div>');
      var actions = el('div', { class: 'card-actions' }, '');
      var editBtn = el('button', { class: 'icon-btn' }, '✏️');
      editBtn.addEventListener('click', function () { openMealModal({ mode: 'edit', meal: meal }); });
      var delBtn = el('button', { class: 'icon-btn' }, '🗑');
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
        var editBtn = el('button', { class: 'icon-btn' }, '✏️');
        editBtn.addEventListener('click', function () { openIngredientModal({ mode: 'edit', ingredient: ing }); });
        var delBtn = el('button', { class: 'icon-btn' }, '🗑');
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
  function renderShoppingRow(key, displayName, checkedMap) {
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
    var label = el('div', { class: 'card-main' }, '<div class="card-title">' + escapeHtml(displayName) + '</div>');
    row.appendChild(checkbox);
    row.appendChild(label);
    shoppingListEl.appendChild(row);
  }
  function renderShoppingList() {
    var weekKey = fmtISO(viewingMonday);
    shoppingListEl.innerHTML = '';
    var weekPlan = state.plan[weekKey] || {};
    var namesByKey = {};
    var orderedKeys = [];
    var planValues = objectValues(weekPlan);
    for (var pi = 0; pi < planValues.length; pi++) {
      var mealId = planValues[pi];
      if (!mealId) continue;
      var meal = arrFind(state.meals, function (m) { return m.id === mealId; });
      if (!meal) continue;
      for (var ii = 0; ii < meal.ingredients.length; ii++) {
        var ing = meal.ingredients[ii];
        var key = ing.name.trim().toLowerCase();
        if (key && !Object.prototype.hasOwnProperty.call(namesByKey, key)) {
          namesByKey[key] = ing.name.trim();
          orderedKeys.push(key);
        }
      }
    }
    if (!orderedKeys.length) {
      shoppingListEl.appendChild(el('div', { class: 'empty-hint' }, "Aucun repas planifié cette semaine pour l'instant."));
      return;
    }
    if (!state.shoppingChecked[weekKey]) state.shoppingChecked[weekKey] = {};
    var checkedMap = state.shoppingChecked[weekKey];
    orderedKeys.sort();
    for (var ki = 0; ki < orderedKeys.length; ki++) {
      renderShoppingRow(orderedKeys[ki], namesByKey[orderedKeys[ki]], checkedMap);
    }
  }

  function renderAll() {
    renderWeekLabel();
    renderPlanningGrid();
    renderMealList();
    renderIngredientList();
    renderShoppingList();
  }

  /* ---------------------------------------------------------------------
   * Modals
   * ------------------------------------------------------------------- */
  function closeModal() { modalRoot.innerHTML = ''; }
  function openModalWith(innerNode) {
    var backdrop = el('div', { class: 'modal-backdrop' }, '');
    var modal = el('div', { class: 'modal' }, '');
    modal.appendChild(innerNode);
    backdrop.appendChild(modal);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    modalRoot.innerHTML = '';
    modalRoot.appendChild(backdrop);
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
    html += '<div class="modal-actions" id="f-actions"></div>';
    wrap.innerHTML = html;

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
      var savedMeal;
      if (isEdit) {
        meal.name = name;
        meal.ingredients = ingredients;
        meal.tags = tags;
        savedMeal = meal;
      } else {
        savedMeal = { id: uid(), name: name, ingredients: ingredients, tags: tags, source: 'manual', usageCount: 0, lastUsedWeekKey: null, history: [] };
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

  function openMealPicker(dayIndex, slot) {
    var weekKey = fmtISO(viewingMonday);
    var key = slotKey(dayIndex, slot);
    var currentMealId = state.plan[weekKey] ? state.plan[weekKey][key] : null;

    var wrap = document.createElement('div');
    var dayDate = addDays(viewingMonday, dayIndex);
    var html = '';
    html += '<h3>' + DAY_NAMES[dayIndex] + ' ' + fmtLong(dayDate) + ' — ' + SLOT_LABELS[slot] + '</h3>';
    html += '<div class="field search-box"><input type="text" id="f-search" placeholder="Rechercher un repas..." /></div>';
    html += '<div class="meal-picker-list" id="f-list"></div>';
    html += '<div id="f-generate-zone"></div>';
    html += '<div class="modal-actions" id="f-picker-actions"></div>';
    wrap.innerHTML = html;

    var listEl = wrap.querySelector('#f-list');
    var searchEl = wrap.querySelector('#f-search');

    function renderList(filter) {
      listEl.innerHTML = '';
      var f = normalizeSearch(filter || '');
      var items = state.meals.filter(function (m) { return strContains(normalizeSearch(m.name), f); })
        .sort(function (a, b) { return a.name.localeCompare(b.name); });
      if (!items.length) {
        listEl.appendChild(el('div', { class: 'empty-hint' }, 'Aucun repas trouvé.'));
        return;
      }
      items.forEach(function (meal) {
        var item = el('div', { class: 'meal-picker-item' }, '<span>' + escapeHtml(meal.name) + ' ' + tagIcons(meal) + '</span>');
        item.addEventListener('click', function () {
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
      var preview = generateMealFromIngredients();
      genZone.innerHTML = '';
      var card = el('div', { class: 'card' }, '<div class="card-main"><div class="card-title">' + escapeHtml(preview.name) + '</div><div class="card-sub">' + tagBadges(preview.tags) + '</div></div>');
      genZone.appendChild(card);
      var btnRow = el('div', { class: 'modal-actions' }, '');
      var useBtn = el('button', { class: 'btn-primary' }, '✅ Utiliser ce repas');
      useBtn.addEventListener('click', function () {
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
    var cancelBtn = el('button', { class: 'btn-ghost' }, 'Fermer');
    cancelBtn.addEventListener('click', closeModal);

    actions.appendChild(generateBtn);
    actions.appendChild(newMealBtn);
    if (currentMealId) actions.appendChild(clearBtn);
    actions.appendChild(cancelBtn);

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

  function gestureStart(clientX, clientY, targetNode) {
    var slotEl = closestSlot(targetNode);
    gestureState = {
      startX: clientX, startY: clientY, startTime: Date.now(),
      slotEl: slotEl, dragMode: false, timer: null
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
      }, 350);
    }
  }
  function gestureMove(clientX, clientY) {
    if (!gestureState) return;
    var dx = clientX - gestureState.startX;
    var dy = clientY - gestureState.startY;
    if (!gestureState.dragMode) {
      if (Math.abs(dx) > 10 || Math.abs(dy) > 10) clearTimeout(gestureState.timer);
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
      if (targetSlot && targetSlot !== gestureState.slotEl) {
        var srcKey = slotKey(gestureState.slotEl.getAttribute('data-day'), gestureState.slotEl.getAttribute('data-slot'));
        var dstKey = slotKey(targetSlot.getAttribute('data-day'), targetSlot.getAttribute('data-slot'));
        swapSlots(weekKey, srcKey, dstKey);
        save();
        renderPlanningGrid();
        if (currentTab === 'shopping') renderShoppingList();
      }
      if (gestureState.slotEl) gestureState.slotEl.classList.remove('dragging');
      clearDragHighlight();
      clearGhost();
    } else {
      var dx = clientX - gestureState.startX;
      var dy = clientY - gestureState.startY;
      var elapsed = Date.now() - gestureState.startTime;
      if (Math.abs(dx) > 55 && Math.abs(dx) > Math.abs(dy) * 1.2) {
        navigateWeek(dx > 0 ? -1 : 1);
      } else if (gestureState.slotEl && Math.abs(dx) < 10 && Math.abs(dy) < 10 && elapsed < 500) {
        openMealPicker(Number(gestureState.slotEl.getAttribute('data-day')), gestureState.slotEl.getAttribute('data-slot'));
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
  $('#btn-add-ingredient').addEventListener('click', function () { openIngredientModal({ mode: 'add' }); });
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
   * Bootstrap
   * ------------------------------------------------------------------- */
  seedIfEmpty();
  state.meta.lastMaintainedDate = fmtISO(new Date());
  maintainHorizon();
  renderAll();

  if ('serviceWorker' in navigator && location.protocol.indexOf('http') === 0) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
