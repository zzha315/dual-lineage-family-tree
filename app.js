const STORAGE_KEY = "dual-lineage-family-tree:v1";
const DEFAULT_USER_ID = "default";
const CURRENT_YEAR = new Date().getFullYear();
const CHILD_LIMIT = 4;
const MAP_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const LOCAL_NODE_WIDTH = 52;
const LOCAL_NODE_HEIGHT = 92;
const LOCAL_COUPLE_GAP = 10;
const LOCAL_UNIT_GAP = 30;
const LOCAL_ROW_STEP = 124;
let leafletLoadPromise = null;

const state = {
  route: parseRoute(),
  data: loadData(),
  modal: null,
  toast: "",
  search: "",
  memberGenderFilter: "",
  memberGenerationFilter: "",
  generationSearch: "",
  generationSearchTimer: null,
  treeSearch: "",
  highlightedId: "",
  expandedUnits: new Set(),
  expandedGlobal: new Set(),
  centerGlobalRequested: parseRoute().name === "globalTree",
  globalView: { scale: 1, x: 0, y: 0, dragging: false, startX: 0, startY: 0 },
};

window.addEventListener("hashchange", () => {
  state.route = parseRoute();
  if (state.route.name === "globalTree") state.centerGlobalRequested = true;
  state.modal = null;
  render();
});

window.addEventListener("family-star-map-ready", () => {
  if (state.route.name === "home") initializeFamilyStarMap();
});

function loadData() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return { persons: [], relations: [] };

  try {
    const parsed = JSON.parse(raw);
    const persons = Array.isArray(parsed.persons) ? parsed.persons.map(normalizePerson) : [];
    return {
      persons,
      relations: Array.isArray(parsed.relations) ? parsed.relations : [],
    };
  } catch {
    return { persons: [], relations: [] };
  }
}

function normalizePerson(person) {
  const next = { ...person };
  if (!("birthTimeType" in next) || !next.birthTimeType) {
    next.birthTimeType = next.birthYear ? "exact" : null;
    next.birthText = null;
  }
  if (next.birthTimeType === "exact") next.birthText = null;
  if (next.birthTimeType === "approx") next.birthYear = null;
  next.isAlive = next.isAlive !== false;
  next.isPlaceholder = Boolean(next.isPlaceholder);
  next.generationLevel =
    next.generationLevel === null || next.generationLevel === undefined || next.generationLevel === ""
      ? null
      : Number(next.generationLevel);
  next.geoScope = next.geoScope || "";
  next.geoLabel = next.geoLabel || "";
  next.geoLat =
    next.geoLat === null || next.geoLat === undefined || next.geoLat === ""
      ? null
      : Number.isFinite(Number(next.geoLat))
        ? Number(next.geoLat)
        : null;
  next.geoLng =
    next.geoLng === null || next.geoLng === undefined || next.geoLng === ""
      ? null
      : Number.isFinite(Number(next.geoLng))
        ? Number(next.geoLng)
        : null;
  next.geoCountry = next.geoCountry || "";
  return next;
}

function saveData() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.data));
}

function exportFamilyData() {
  const payload = {
    app: "dual-lineage-family-tree",
    version: 1,
    exportedAt: nowIso(),
    data: state.data,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const stamp = new Date().toISOString().slice(0, 10);
  link.href = url;
  link.download = `dual-lineage-family-tree-backup-${stamp}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  notify("数据备份文件已生成。");
}

function importFamilyDataFromFile(file) {
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const parsed = JSON.parse(String(reader.result || ""));
      const imported = parsed?.data && Array.isArray(parsed.data.persons) ? parsed.data : parsed;
      if (!Array.isArray(imported?.persons) || !Array.isArray(imported?.relations)) {
        throw new Error("INVALID_BACKUP");
      }
      const shouldImport =
        !activePersons().length ||
        window.confirm("导入会覆盖当前浏览器里的家谱数据。确认继续吗？");
      if (!shouldImport) return;
      state.data = {
        persons: imported.persons.map(normalizePerson),
        relations: imported.relations.map((relation) => ({ ...relation })),
      };
      reconcileFamilyRelations();
      saveData();
      state.highlightedId = "";
      state.modal = null;
      render();
      notify("数据已导入当前浏览器。");
    } catch {
      notify("导入失败：请选择有效的家谱备份 JSON 文件。");
    }
  };
  reader.readAsText(file, "utf-8");
}

function chooseFamilyDataImportFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "application/json,.json";
  input.addEventListener("change", () => importFamilyDataFromFile(input.files?.[0]));
  input.click();
}

function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] === "persons" && parts[1]) return { name: "personDetail", id: parts[1] };
  if (parts[0] === "persons") return { name: "persons" };
  if (parts[0] === "dashboard") return { name: "dashboard" };
  if (parts[0] === "incomplete") return { name: "incomplete" };
  if (parts[0] === "tree" && parts[1] === "global") return { name: "home" };
  if (parts[0] === "tree" && parts[1] === "local" && parts[2]) return { name: "tree", id: parts[2] };
  if (parts[0] === "tree" && parts[1]) return { name: "tree", id: parts[1] };
  if (parts[0] === "tree") return { name: "tree" };
  return { name: "home" };
}

function go(path) {
  location.hash = path;
}

function uid(prefix) {
  if (window.crypto?.randomUUID) return `${prefix}_${crypto.randomUUID()}`;
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function activePersons() {
  return state.data.persons
    .filter((person) => !person.isDeleted)
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
}

function activeRelations() {
  return state.data.relations.filter((relation) => !relation.isDeleted);
}

function getSelf() {
  return activePersons().find((person) => person.isSelf) || null;
}

function getFocusPerson() {
  return getPerson(state.highlightedId) || getSelf() || activePersons()[0] || null;
}

function getFamilyStarGraphData() {
  return {
    focusId: getFocusPerson()?.id || "",
    persons: activePersons().map((person) => ({
      id: person.id,
      name: person.name,
      gender: person.gender,
      generationLevel: person.generationLevel,
      geoLabel: person.geoLabel || "",
    })),
    relations: activeRelations().map((relation) => ({
      fromPersonId: relation.fromPersonId,
      toPersonId: relation.toPersonId,
      type: relation.type,
      role: relation.role,
    })),
  };
}

function initializeFamilyStarMap() {
  const container = document.getElementById("family-star-map");
  if (!container || !window.FamilyStarMap) return;
  window.FamilyStarMap.mount(container, getFamilyStarGraphData(), {
    onFocus(id) {
      state.highlightedId = id;
      updateStarPersonPanel(id);
    },
  });
  document.getElementById("star-map-fallback")?.remove();
}

function updateStarPersonPanel(id) {
  const person = getPerson(id);
  if (!person) return;
  const name = document.getElementById("star-person-name");
  const meta = document.getElementById("star-person-meta");
  if (name) name.textContent = person.name;
  if (meta) {
    meta.textContent = `${formatGenerationLevel(person.generationLevel)}${person.geoLabel ? ` · ${person.geoLabel}` : ""}`;
  }
}

function getPerson(id) {
  return activePersons().find((person) => person.id === id) || null;
}

function getParentRelationsForChild(childId) {
  return activeRelations().filter((relation) => relation.toPersonId === childId && relation.type === "parent");
}

function uniquePersons(persons) {
  const seen = new Set();
  return persons.filter((person) => {
    if (!person || seen.has(person.id)) return false;
    seen.add(person.id);
    return true;
  });
}

function getParentIdsForChild(childId) {
  return getParentRelationsForChild(childId).map((relation) => relation.fromPersonId);
}

function getChildrenIdsForParent(parentId) {
  return activeRelations()
    .filter((relation) => relation.type === "parent" && relation.fromPersonId === parentId)
    .map((relation) => relation.toPersonId);
}

function getSiblingCandidatesByParents(id) {
  const siblingIds = new Set();
  getParentIdsForChild(id).forEach((parentId) => {
    getChildrenIdsForParent(parentId).forEach((childId) => {
      if (childId !== id) siblingIds.add(childId);
    });
  });
  return [...siblingIds].map(getPerson).filter(Boolean);
}

function getRelationsFor(id) {
  const relations = activeRelations();
  const fatherRel = relations.find(
    (relation) => relation.toPersonId === id && relation.type === "parent" && relation.role === "father",
  );
  const motherRel = relations.find(
    (relation) => relation.toPersonId === id && relation.type === "parent" && relation.role === "mother",
  );
  const spouseRels = relations.filter(
    (relation) => relation.fromPersonId === id && relation.type === "spouse" && relation.role === "spouse",
  );
  const childRels = relations.filter((relation) => relation.fromPersonId === id && relation.type === "parent");
  const siblingRels = relations.filter((relation) => relation.toPersonId === id && relation.type === "sibling");
  const explicitSiblings = siblingRels.map((relation) => getPerson(relation.fromPersonId)).filter(Boolean);

  return {
    father: fatherRel ? getPerson(fatherRel.fromPersonId) : null,
    mother: motherRel ? getPerson(motherRel.fromPersonId) : null,
    spouses: spouseRels.map((relation) => getPerson(relation.toPersonId)).filter(Boolean),
    children: uniquePersons(childRels.map((relation) => getPerson(relation.toPersonId)).filter(Boolean)),
    siblings: uniquePersons([...explicitSiblings, ...getSiblingCandidatesByParents(id)]),
  };
}

function getFamilyUnitsFor(centerId) {
  const center = getPerson(centerId);
  if (!center) return [];

  const { spouses, children } = getRelationsFor(centerId);
  const assigned = new Set();
  const units = spouses.map((spouse) => {
    const unitChildren = children.filter((child) => {
      const parentIds = getParentRelationsForChild(child.id).map((relation) => relation.fromPersonId);
      return parentIds.includes(centerId) && parentIds.includes(spouse.id);
    });
    unitChildren.forEach((child) => assigned.add(child.id));
    return {
      id: `unit:${centerId}:${spouse.id}`,
      label: `与 ${spouse.name} 的家庭`,
      spouse,
      children: unitChildren,
    };
  });

  const unknownChildren = children.filter((child) => !assigned.has(child.id));
  if (unknownChildren.length || !units.length) {
    units.push({
      id: `unit:${centerId}:unknown`,
      label: spouses.length ? "未知另一方" : "子女",
      spouse: null,
      children: unknownChildren,
    });
  }

  return units;
}

function createPerson(input) {
  const timestamp = nowIso();
  const person = normalizePerson({
    id: uid("person"),
    userId: DEFAULT_USER_ID,
    name: input.name.trim(),
    gender: input.gender,
    birthTimeType: input.birthTimeType || null,
    birthYear: input.birthYear || null,
    birthText: input.birthText || null,
    generationLevel: input.generationLevel ?? null,
    geoScope: input.geoScope || "",
    geoLabel: input.geoLabel || "",
    geoLat: input.geoLat ?? null,
    geoLng: input.geoLng ?? null,
    geoCountry: input.geoCountry || "",
    isAlive: input.isAlive ?? true,
    avatarUrl: input.avatarUrl || "",
    bio: input.bio || "",
    isSelf: Boolean(input.isSelf),
    isPlaceholder: Boolean(input.isPlaceholder),
    isDeleted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  state.data.persons.push(person);
  return person;
}

function createRelation(input) {
  const timestamp = nowIso();
  const relation = {
    id: uid("relation"),
    userId: DEFAULT_USER_ID,
    fromPersonId: input.fromPersonId,
    toPersonId: input.toPersonId,
    type: input.type,
    role: input.role,
    sortGroup: null,
    sortOrder: 0,
    isDeleted: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  state.data.relations.push(relation);
  return relation;
}

function createRelationIfMissing(input) {
  const exists = activeRelations().find(
    (relation) =>
      relation.fromPersonId === input.fromPersonId &&
      relation.toPersonId === input.toPersonId &&
      relation.type === input.type &&
      (input.type === "sibling" || relation.role === input.role),
  );
  if (exists) {
    if (input.type === "sibling" && exists.role !== input.role) {
      exists.role = input.role;
      exists.updatedAt = nowIso();
      return true;
    }
    return false;
  }
  createRelation(input);
  return true;
}

function createSpousePairIfMissing(firstId, secondId) {
  if (!firstId || !secondId || firstId === secondId) return false;
  let changed = false;
  changed =
    createRelationIfMissing({ fromPersonId: firstId, toPersonId: secondId, type: "spouse", role: "spouse" }) ||
    changed;
  changed =
    createRelationIfMissing({ fromPersonId: secondId, toPersonId: firstId, type: "spouse", role: "spouse" }) ||
    changed;
  return changed;
}

function getSiblingReverseRole(role) {
  return {
    olderBrother: "youngerBrother",
    youngerBrother: "olderBrother",
    olderSister: "youngerSister",
    youngerSister: "olderSister",
  }[role];
}

function compareSiblingOrder(first, second) {
  const firstYear = first.birthTimeType === "exact" ? Number(first.birthYear) : null;
  const secondYear = second.birthTimeType === "exact" ? Number(second.birthYear) : null;
  if (Number.isFinite(firstYear) && Number.isFinite(secondYear) && firstYear !== secondYear) {
    return firstYear - secondYear;
  }
  const firstCreated = new Date(first.createdAt || 0).getTime();
  const secondCreated = new Date(second.createdAt || 0).getTime();
  if (Number.isFinite(firstCreated) && Number.isFinite(secondCreated) && firstCreated !== secondCreated) {
    return firstCreated - secondCreated;
  }
  return first.name.localeCompare(second.name, "zh-CN");
}

function getSiblingRoleFor(fromPerson, toPerson) {
  const older = compareSiblingOrder(fromPerson, toPerson) <= 0;
  if (fromPerson.gender === "female") return older ? "olderSister" : "youngerSister";
  return older ? "olderBrother" : "youngerBrother";
}

function reconcileFamilyRelations() {
  let changed = false;
  activePersons().forEach((child) => {
    const parents = getParentRelationsForChild(child.id).map((relation) => relation.fromPersonId);
    if (parents.length >= 2) {
      changed = createSpousePairIfMissing(parents[0], parents[1]) || changed;
    }
  });

  activePersons().forEach((person) => {
    getSiblingCandidatesByParents(person.id).forEach((sibling) => {
      changed =
        createRelationIfMissing({
          fromPersonId: sibling.id,
          toPersonId: person.id,
          type: "sibling",
          role: getSiblingRoleFor(sibling, person),
        }) || changed;
      changed =
        createRelationIfMissing({
          fromPersonId: person.id,
          toPersonId: sibling.id,
          type: "sibling",
          role: getSiblingRoleFor(person, sibling),
        }) || changed;
    });
  });
  return changed;
}

function copyKnownParents(fromPersonId, toPersonId) {
  const relations = getRelationsFor(fromPersonId);
  if (relations.father) {
    createRelationIfMissing({ fromPersonId: relations.father.id, toPersonId, type: "parent", role: "father" });
  }
  if (relations.mother) {
    createRelationIfMissing({ fromPersonId: relations.mother.id, toPersonId, type: "parent", role: "mother" });
  }
}

function syncChildrenToParent(parentId, children, role) {
  children.forEach((child) => {
    createRelationIfMissing({ fromPersonId: parentId, toPersonId: child.id, type: "parent", role });
  });
}

function syncOriginalFamilyChildren(parentId, otherParentId, role) {
  if (!parentId || !otherParentId) return;
  const otherParentChildren = getRelationsFor(otherParentId).children;
  syncChildrenToParent(parentId, otherParentChildren, role);
}

function syncParentToKnownSiblings(parentId, childId, role) {
  getRelationsFor(childId).siblings.forEach((sibling) => {
    createRelationIfMissing({ fromPersonId: parentId, toPersonId: sibling.id, type: "parent", role });
  });
}

function deriveRelativeGeneration(base, relationType) {
  if (base.generationLevel === null || base.generationLevel === undefined) return null;
  if (relationType === "father" || relationType === "mother") return base.generationLevel + 1;
  if (relationType === "son" || relationType === "daughter") return base.generationLevel - 1;
  return base.generationLevel;
}

function formatGenerationLevel(level) {
  if (level === null || level === undefined || level === "") return "未设置";
  const value = Number(level);
  if (value === 0) return "同级";
  if (value > 0) return `上${value}级`;
  return `下${Math.abs(value)}级`;
}

function generationSortValue(level) {
  return level === null || level === undefined ? -999 : Number(level);
}

function getSurname(person) {
  return (person.name || "").trim().slice(0, 1);
}

function inferUniqueOtherParent(baseId, newChildId) {
  const spouses = getRelationsFor(baseId).spouses;
  if (spouses.length === 1) return spouses[0];
  if (spouses.length > 1) return null;

  const otherParentIds = new Set();
  activeRelations()
    .filter(
      (relation) =>
        relation.type === "parent" &&
        relation.fromPersonId === baseId &&
        relation.toPersonId !== newChildId,
    )
    .forEach((relation) => {
      getParentRelationsForChild(relation.toPersonId)
        .filter((parentRelation) => parentRelation.fromPersonId !== baseId)
        .forEach((parentRelation) => otherParentIds.add(parentRelation.fromPersonId));
    });

  if (otherParentIds.size !== 1) return null;
  return getPerson([...otherParentIds][0]);
}

function validateBirthTime(input) {
  const errors = {};
  if (input.birthTimeType === "exact") {
    const value = input.birthYear?.trim();
    if (value && !/^\d+$/.test(value)) {
      errors.birthYear = "出生年份必须是整数数字";
    } else if (value && (Number(value) < 1 || Number(value) > CURRENT_YEAR)) {
      errors.birthYear = `出生年份范围应为 1 到 ${CURRENT_YEAR}`;
    }
  }

  if (input.birthTimeType === "approx") {
    const value = input.birthText?.trim();
    if (value && value.length > 10) errors.birthText = "模糊时间最多输入10个字";
  }
  return errors;
}

function readPersonForm(form, overrides = {}) {
  const errors = {};
  const name = form.name.value.trim();
  if (!name) errors.name = "请填写姓名";

  const birthTimeType = form.birthTimeType?.value || "exact";
  Object.assign(
    errors,
    validateBirthTime({
      birthTimeType,
      birthYear: form.birthYear?.value || "",
      birthText: form.birthText?.value || "",
    }),
  );

  showFormErrors(form, errors);
  if (Object.keys(errors).length) {
    form.querySelector(".field-error:not(:empty)")?.scrollIntoView({ block: "center", behavior: "smooth" });
    throw new Error("FORM_HAS_INLINE_ERRORS");
  }

  const birthYearValue = form.birthYear?.value.trim();
  const birthTextValue = form.birthText?.value.trim();
  const generationValue = form.generationLevel?.value ?? "";
  const geoLatValue = form.geoLat?.value ?? "";
  const geoLngValue = form.geoLng?.value ?? "";
  return {
    name,
    gender: overrides.gender || form.gender?.value || "male",
    birthTimeType,
    birthYear: birthTimeType === "exact" && birthYearValue ? Number(birthYearValue) : null,
    birthText: birthTimeType === "approx" && birthTextValue ? birthTextValue : null,
    generationLevel: generationValue === "" ? null : Number(generationValue),
    geoScope: form.geoScope?.value || "",
    geoLabel: form.geoLabel?.value?.trim() || form.geoQuery?.value?.trim() || "",
    geoLat: geoLatValue === "" ? null : Number(geoLatValue),
    geoLng: geoLngValue === "" ? null : Number(geoLngValue),
    geoCountry: form.geoCountry?.value || "",
    isAlive: form.isAlive ? form.isAlive.checked : true,
    isPlaceholder: form.isPlaceholder ? form.isPlaceholder.checked : false,
    bio: form.bio?.value?.trim() || "",
    avatarUrl: "",
    ...overrides,
  };
}

function showFormErrors(form, errors) {
  form.querySelectorAll("[data-error-for]").forEach((node) => {
    node.textContent = errors[node.dataset.errorFor] || "";
  });
}

function submitSelf(form) {
  if (activePersons().length) {
    notify("已有成员档案，请从成员详情继续添加亲属。");
    return;
  }

  const values = readPersonForm(form, { isSelf: true });
  if (values.generationLevel === null) values.generationLevel = 0;
  const person = createPerson(values);
  saveData();
  go(`/tree/local/${person.id}`);
  notify("第一位成员档案已创建。");
}

function updatePerson(id, form) {
  const person = getPerson(id);
  if (!person) return;

  const values = readPersonForm(form);
  Object.assign(person, values, { updatedAt: nowIso() });
  reconcileFamilyRelations();
  saveData();
  state.modal = null;
  render();
  notify("成员信息已更新。");
}

function softDeletePerson(id) {
  const person = getPerson(id);
  if (!person) return;

  person.isDeleted = true;
  person.updatedAt = nowIso();
  state.data.relations.forEach((relation) => {
    if (relation.fromPersonId === id || relation.toPersonId === id) {
      relation.isDeleted = true;
      relation.updatedAt = nowIso();
    }
  });
  saveData();
  state.modal = null;
  go("/persons");
  notify("成员已软删除，相关关系也已停用。");
}

function addRelative(baseId, relationType, form) {
  const base = getPerson(baseId);
  if (!base) return;

  const existing = getRelationsFor(baseId);
  if (relationType === "father" && existing.father) throw new Error("该成员已有父亲。");
  if (relationType === "mother" && existing.mother) throw new Error("该成员已有母亲。");

  const forcedGender =
    relationType === "father" ||
    relationType === "son" ||
    relationType === "olderBrother" ||
    relationType === "youngerBrother"
      ? "male"
      : relationType === "mother" ||
          relationType === "daughter" ||
          relationType === "olderSister" ||
          relationType === "youngerSister"
        ? "female"
        : null;
  const relative = createPerson(readPersonForm(form, forcedGender ? { gender: forcedGender } : {}));
  if (relative.generationLevel === null || relative.generationLevel === undefined) {
    relative.generationLevel = deriveRelativeGeneration(base, relationType);
  }

  if (relationType === "father" || relationType === "mother") {
    createRelationIfMissing({ fromPersonId: relative.id, toPersonId: base.id, type: "parent", role: relationType });
    const otherParent = relationType === "father" ? existing.mother : existing.father;
    if (otherParent) {
      createSpousePairIfMissing(relative.id, otherParent.id);
      syncOriginalFamilyChildren(relative.id, otherParent.id, relationType);
    }
    syncParentToKnownSiblings(relative.id, base.id, relationType);
  }

  if (relationType === "son" || relationType === "daughter") {
    createRelationIfMissing({
      fromPersonId: base.id,
      toPersonId: relative.id,
      type: "parent",
      role: base.gender === "female" ? "mother" : "father",
    });
    const otherParent = inferUniqueOtherParent(base.id, relative.id);
    if (otherParent) {
      createRelationIfMissing({
        fromPersonId: otherParent.id,
        toPersonId: relative.id,
        type: "parent",
        role: otherParent.gender === "female" ? "mother" : "father",
      });
      createSpousePairIfMissing(base.id, otherParent.id);
    }
  }

  if (relationType === "spouse") {
    createSpousePairIfMissing(base.id, relative.id);
    syncChildrenToParent(relative.id, existing.children, relative.gender === "female" ? "mother" : "father");
  }

  if (getSiblingReverseRole(relationType)) {
    createRelationIfMissing({ fromPersonId: relative.id, toPersonId: base.id, type: "sibling", role: relationType });
    createRelationIfMissing({
      fromPersonId: base.id,
      toPersonId: relative.id,
      type: "sibling",
      role: getSiblingReverseRole(relationType),
    });
    copyKnownParents(base.id, relative.id);
  }

  reconcileFamilyRelations();
  saveData();
  state.modal = null;
  render();
  notify("亲属已添加。");
}

function notify(message) {
  state.toast = message;
  render();
  clearTimeout(notify.timer);
  notify.timer = setTimeout(() => {
    state.toast = "";
    render();
  }, 2600);
}

function normalizeMemberNameQuery(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[0-9\s]/g, "");
}

function formatBirthTime(person) {
  if (person.birthTimeType === "exact" && person.birthYear) return `${person.birthYear}年`;
  if (person.birthTimeType === "approx" && person.birthText) return person.birthText;
  return "未填写";
}

function searchPersons(query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return activePersons()
    .filter((person) => {
      const haystack = [
        person.name,
        formatBirthTime(person),
        person.birthText,
        person.bio,
        person.isPlaceholder ? "占位 待补充" : "",
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    })
    .slice(0, 8);
}

function render() {
  const app = document.getElementById("app");
  app.innerHTML = shellV2(renderPage());
  bindEvents(app);
  if (state.route.name === "dashboard") requestAnimationFrame(bindDashboardMapDisclosure);
  if (state.route.name === "tree") requestAnimationFrame(centerLocalKinshipView);
  if (state.route.name === "globalTree" && state.centerGlobalRequested) {
    requestAnimationFrame(centerGlobalCanvasOnFocus);
  }
  if (state.route.name === "home" && activePersons().length) {
    requestAnimationFrame(initializeFamilyStarMap);
    setTimeout(() => {
      const fallback = document.getElementById("star-map-fallback");
      if (fallback && !window.FamilyStarMap) {
        fallback.innerHTML = `<div><strong>家族星图未能加载</strong><p>请确认 star-map.js 与 index.html 位于同一文件夹。成员表和其他家谱功能仍可正常使用。</p></div>`;
      }
    }, 8000);
  }
}

function shellV2(content) {
  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <strong>双系家谱</strong>
          <span>星图总览、局部谱系、成员档案</span>
        </div>
        <nav class="nav">
          <button data-export-family>导出数据</button>
          <button data-import-family>导入数据</button>
          <button data-go="/">家族星图</button>
          <button data-go="/persons">成员表</button>
          <button data-go="/tree">局部谱</button>
          <button data-go="/dashboard">统计看板</button>
          <button data-go="/incomplete">待补充</button>
        </nav>
      </header>
      <main class="page">${content}</main>
      ${state.modal ? renderModal(state.modal) : ""}
      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    </div>
  `;
}

function shell(content) {
  return `
    <div class="app-shell">
      <header class="topbar">
        <div class="brand">
          <strong>双系家谱</strong>
          <span>星图总览、二维关系、成员编辑</span>
        </div>
        <nav class="nav">
          <button data-go="/">⌂ 首页</button>
          <button data-go="/tree">◎ 局部树</button>
          <button data-go="/">家族星图</button>
          <button data-go="/incomplete">※ 待补充</button>
          <button data-go="/persons">☷ 成员</button>
          <button data-go="/dashboard">辈分看板</button>
        </nav>
      </header>
      <main class="page">${content}</main>
      ${state.modal ? renderModal(state.modal) : ""}
      ${state.toast ? `<div class="toast">${escapeHtml(state.toast)}</div>` : ""}
    </div>
  `;
}

function renderPage() {
  if (state.route.name === "persons") return renderPersonsTablePage();
  if (state.route.name === "personDetail") return renderPersonDetailPage(state.route.id);
  if (state.route.name === "tree") return renderLocalKinshipPage(state.route.id);
  if (state.route.name === "dashboard") return renderGenerationDashboardPage();
  if (state.route.name === "incomplete") return renderIncompletePageV2();
  return renderHomeStarMap();
}

function renderHomeStarMap() {
  const persons = activePersons();
  if (!persons.length) return renderHomePageV2();
  const focus = getFocusPerson();
  return `
    <section class="star-home" id="star-home">
      <div class="star-stage" id="family-star-map" aria-label="可旋转家族星图"></div>
      <div class="star-toolbar">
        <div class="star-title">
          <h1>家族星图</h1>
          <p>拖动旋转 · 滚轮缩放 · 点击成员重新聚焦</p>
        </div>
        <div class="star-search">
          <input id="star-search-input" type="search" placeholder="搜索成员姓名" autocomplete="off" />
          <div id="star-search-results" class="star-search-results"></div>
        </div>
      </div>
      <aside class="star-person-panel" id="star-person-panel">
        <span class="star-panel-label">观察中心</span>
        <h2 id="star-person-name">${escapeHtml(focus.name)}</h2>
        <p id="star-person-meta">${escapeHtml(formatGenerationLevel(focus.generationLevel))}${focus.geoLabel ? ` · ${escapeHtml(focus.geoLabel)}` : ""}</p>
        <div class="actions">
          <button data-star-detail>成员资料</button>
          <button data-star-local>局部图</button>
        </div>
      </aside>
      <div class="star-legend">
        <span><i class="blood"></i>生育线</span>
        <span><i class="marriage"></i>婚姻线</span>
        <span><i class="sibling"></i>兄弟姐妹</span>
        <span><i class="male"></i>男性</span>
        <span><i class="female"></i>女性</span>
      </div>
      <div class="star-map-fallback" id="star-map-fallback">
        <strong>正在载入家族星图...</strong>
      </div>
    </section>
  `;
}

function renderHomePageV2() {
  const persons = activePersons();
  if (!persons.length) {
    return `
      <section class="home-overview">
        <div>
          <h1>双系家谱</h1>
          <p class="muted">先创建第一位家庭成员。之后每位成员都可以作为局部图或全局图的观察中心。</p>
        </div>
      </section>
      <section class="section">
        <div class="section-title">
          <h2>创建第一位成员</h2>
          <span class="muted">创建后可继续添加完整家庭关系</span>
        </div>
        ${renderPersonForm({ id: "self-form", submitText: "创建并进入家谱" })}
      </section>
    `;
  }

  const focus = getFocusPerson();
  return `
    <section class="home-overview">
      <div>
        <h1>双系家谱</h1>
        <p class="muted">选择任意成员作为观察中心，进入局部图、全局图或统计地图。</p>
      </div>
      <div class="actions">
        <button class="primary" data-go="/tree/local/${focus.id}">局部图</button>
        <button data-go="/" data-highlight="${focus.id}">家族星图</button>
        <button data-go="/dashboard">统计与地图</button>
      </div>
    </section>
    <section class="section">
      <div class="section-title">
        <div>
          <h2>选择观察成员</h2>
          <p class="muted">当前观察中心：${escapeHtml(focus.name)}</p>
        </div>
        <button data-go="/persons">完整成员列表</button>
      </div>
      <div class="home-person-grid">
        ${persons
          .map(
            (person) => `
              <article class="home-person ${person.gender} ${person.id === focus.id ? "selected" : ""}">
                <button class="home-person-name" data-set-focus="${person.id}">${escapeHtml(person.name)}</button>
                <span>${escapeHtml(formatGenerationLevel(person.generationLevel))}</span>
                <div class="home-person-actions">
                  <button data-go="/tree/local/${person.id}">局部</button>
                  <button data-go="/" data-highlight="${person.id}">星图</button>
                </div>
              </article>
            `,
          )
          .join("")}
      </div>
    </section>
  `;
}

function renderHomePage() {
  const self = getSelf();
  if (!self) {
    return `
      <section class="hero">
        <div class="hero-copy">
          <h1>双系家谱</h1>
          <p>从“我”开始建立档案。出生时间可填精确年份，也可填“清末”“19世纪20年代”这样的模糊时间。</p>
        </div>
      </section>
      <section class="section">
        <div class="section-title">
          <h2>创建我的档案</h2>
          <span class="muted">首次使用只需要这一步</span>
        </div>
        ${renderPersonForm({ id: "self-form", submitText: "创建并进入家谱" })}
      </section>
    `;
  }

  return `
    <section class="hero">
      <div class="hero-copy">
        <h1>双系家谱</h1>
        <p>当前根成员是 ${escapeHtml(self.name)}。局部树负责精确编辑，全局图负责定位和看全貌，待补充列表负责推动资料完善。</p>
        <div class="actions">
          <button class="primary" data-go="/tree/local/${self.id}">◎ 局部树</button>
          <button data-go="/">家族星图</button>
          <button data-go="/incomplete">※ 待补充</button>
        </div>
      </div>
    </section>
    <section class="section">
      <div class="section-title"><h2>本人档案</h2></div>
      <div class="grid-list">${renderPersonCard(self, { detail: true })}</div>
    </section>
  `;
}

function renderPersonsTablePage() {
  const query = normalizeMemberNameQuery(state.search);
  const generationOptions = [...new Set(
    activePersons()
      .map((person) => person.generationLevel)
      .filter((level) => level !== null && level !== undefined),
  )].sort((a, b) => b - a);
  const persons = activePersons().filter((person) => {
    if (query && !normalizeMemberNameQuery(person.name).includes(query)) return false;
    if (state.memberGenderFilter && person.gender !== state.memberGenderFilter) return false;
    if (
      state.memberGenerationFilter !== "" &&
      String(person.generationLevel) !== state.memberGenerationFilter
    ) {
      return false;
    }
    return true;
  });

  return `
    <section class="section">
      <div class="section-title">
        <div>
          <h2>全员成员表</h2>
          <p class="muted">当前显示 ${persons.length} / ${activePersons().length} 位成员</p>
        </div>
      </div>
      <div class="member-table-filters">
        <input id="search" type="search" placeholder="搜索姓名、地域或亲属姓名" value="${escapeAttr(state.search)}" />
        <select id="member-gender-filter">
          <option value="">全部性别</option>
          <option value="male" ${state.memberGenderFilter === "male" ? "selected" : ""}>男</option>
          <option value="female" ${state.memberGenderFilter === "female" ? "selected" : ""}>女</option>
        </select>
        <select id="member-generation-filter">
          <option value="">全部辈分</option>
          ${generationOptions
            .map(
              (level) =>
                `<option value="${level}" ${state.memberGenerationFilter === String(level) ? "selected" : ""}>${escapeHtml(formatGenerationLevel(level))}</option>`,
            )
            .join("")}
        </select>
      </div>
      ${
        persons.length
          ? `<div class="member-table-wrap">
              <table class="member-table">
                <thead>
                  <tr>
                    <th>姓名</th>
                    <th>性别</th>
                    <th>辈分</th>
                    <th>地域</th>
                    <th>父亲</th>
                    <th>母亲</th>
                    <th>配偶</th>
                    <th>操作</th>
                  </tr>
                </thead>
                <tbody>
                  ${persons.map(renderMemberTableRow).join("")}
                </tbody>
              </table>
            </div>`
          : `<div class="empty-state"><h3>没有匹配成员</h3><p class="muted">调整搜索词或筛选条件后重试。</p></div>`
      }
    </section>
  `;
}

function renderMemberTableRow(person) {
  const relations = getRelationsFor(person.id);
  return `
    <tr>
      <td><button class="member-name-link ${person.gender}" data-go="/persons/${person.id}">${escapeHtml(person.name)}</button></td>
      <td><span class="gender-text ${person.gender}">${person.gender === "female" ? "女" : "男"}</span></td>
      <td>${escapeHtml(formatGenerationLevel(person.generationLevel))}</td>
      <td title="${escapeAttr(person.geoLabel || "")}">${escapeHtml(person.geoLabel || "未设置")}</td>
      <td>${relations.father ? escapeHtml(relations.father.name) : "—"}</td>
      <td>${relations.mother ? escapeHtml(relations.mother.name) : "—"}</td>
      <td>${relations.spouses.length ? relations.spouses.map((spouse) => escapeHtml(spouse.name)).join("、") : "—"}</td>
      <td>
        <div class="table-actions">
          <button data-go="/tree/local/${person.id}">局部谱</button>
          <button data-modal="edit:${person.id}">编辑</button>
        </div>
      </td>
    </tr>
  `;
}

function renderPersonsPage() {
  const query = state.search.trim().toLowerCase();
  const persons = activePersons().filter((person) => {
    if (!query) return true;
    return `${person.name} ${formatBirthTime(person)} ${person.bio || ""}`.toLowerCase().includes(query);
  });
  return `
    <section class="section">
      <div class="section-title">
        <div>
          <h2>成员列表</h2>
          <p class="muted">共 ${persons.length} 位未删除成员</p>
        </div>
        <div class="search-row">
          <input id="search" type="search" placeholder="搜索姓名 / 出生时间 / 简介" value="${escapeAttr(state.search)}" />
        </div>
      </div>
      ${
        persons.length
          ? `<div class="grid-list">${persons.map((person) => renderPersonCard(person, { detail: true })).join("")}</div>`
          : `<div class="empty-state"><h3>暂无匹配成员</h3><p class="muted">可以回到某个成员详情页添加亲属。</p></div>`
      }
    </section>
  `;
}

function renderPersonDetailPage(id) {
  const person = getPerson(id);
  if (!person) return renderMissing("没有找到这个成员，可能已经被删除。");

  const relations = getRelationsFor(id);
  return `
    <section class="section">
      <div class="toolbar">
        <div>
          <h2>${escapeHtml(person.name)}</h2>
          <p class="muted">成员详情</p>
        </div>
        <div class="actions">
          <button data-go="/tree/local/${person.id}">◎ 局部树</button>
          <button data-go="/" data-highlight="${person.id}">在星图中查看</button>
          <button data-modal="edit:${person.id}">✎ 编辑</button>
          <button class="danger" data-modal="delete:${person.id}">⌫ 删除</button>
        </div>
      </div>
      <div class="detail-panel section">
        ${renderPersonSummary(person)}
        ${person.bio ? `<p class="muted">${escapeHtml(person.bio)}</p>` : ""}
      </div>
      <div class="section-title"><h2>添加亲属</h2></div>
      <div class="actions section">
        <button ${relations.father ? "disabled" : ""} data-modal="relative:${person.id}:father">＋ 父亲</button>
        <button ${relations.mother ? "disabled" : ""} data-modal="relative:${person.id}:mother">＋ 母亲</button>
        <button data-modal="relative:${person.id}:son">＋ 儿子</button>
        <button data-modal="relative:${person.id}:daughter">＋ 女儿</button>
        <button data-modal="relative:${person.id}:spouse">＋ 配偶</button>
        <button data-modal="relative:${person.id}:olderBrother">+ 哥哥</button>
        <button data-modal="relative:${person.id}:youngerBrother">+ 弟弟</button>
        <button data-modal="relative:${person.id}:olderSister">+ 姐姐</button>
        <button data-modal="relative:${person.id}:youngerSister">+ 妹妹</button>
      </div>
      <div class="relation-grid">
        ${renderRelationSection("兄弟姐妹", relations.siblings)}
        ${renderRelationSection("父亲", relations.father ? [relations.father] : [])}
        ${renderRelationSection("母亲", relations.mother ? [relations.mother] : [])}
        ${renderRelationSection("配偶", relations.spouses)}
        ${renderRelationSection("子女", relations.children)}
      </div>
    </section>
  `;
}

function renderTreeSearch() {
  const results = searchPersons(state.treeSearch);
  return `
    <div class="tree-search">
      <input id="tree-search" type="search" placeholder="搜索姓名、出生时间、待补充" value="${escapeAttr(state.treeSearch)}" />
      ${
        results.length
          ? `<div class="search-results">${results
              .map((person) => `<button data-focus-person="${person.id}">${escapeHtml(person.name)}<span>${escapeHtml(formatBirthTime(person))}</span></button>`)
              .join("")}</div>`
          : ""
      }
    </div>
  `;
}

function buildLocalKinshipGraph(centerId, maxDepth = 3) {
  const center = getPerson(centerId);
  if (!center) return { nodes: [], edges: [], width: 900, height: 760 };
  const included = new Map([[center.id, { person: center, generation: 0, kind: "center" }]]);

  function addAncestors(childId, depth) {
    if (depth > maxDepth) return;
    getParentRelationsForChild(childId).forEach((relation) => {
      const parent = getPerson(relation.fromPersonId);
      if (!parent) return;
      if (!included.has(parent.id)) {
        included.set(parent.id, { person: parent, generation: depth, kind: "ancestor" });
      }
      addAncestors(parent.id, depth + 1);
    });
  }

  function addDescendants(parentId, depth) {
    if (depth > maxDepth) return;
    activeRelations()
      .filter((relation) => relation.type === "parent" && relation.fromPersonId === parentId)
      .forEach((relation) => {
        const child = getPerson(relation.toPersonId);
        if (!child) return;
        if (!included.has(child.id)) {
          included.set(child.id, { person: child, generation: -depth, kind: "descendant" });
        }
        addDescendants(child.id, depth + 1);
      });
  }

  addAncestors(center.id, 1);
  addDescendants(center.id, 1);
  const centerRelations = getRelationsFor(center.id);
  centerRelations.siblings.forEach((person) => {
    if (!included.has(person.id)) included.set(person.id, { person, generation: 0, kind: "sibling" });
  });
  centerRelations.spouses.forEach((person) => {
    if (!included.has(person.id)) included.set(person.id, { person, generation: 0, kind: "spouse" });
  });

  // Keep the local view centered on the focus person's bloodline. Spouses are
  // shown as side attachments, but their own parents are not pulled into this
  // view; clicking a spouse recenters the graph on that person's bloodline.
  [...included.values()].forEach((entry) => {
    getRelationsFor(entry.person.id).spouses.forEach((spouse) => {
      if (!included.has(spouse.id)) {
        included.set(spouse.id, { person: spouse, generation: entry.generation, kind: "spouse" });
      }
    });
  });

  const levels = new Map();
  included.forEach((entry) => {
    if (!levels.has(entry.generation)) levels.set(entry.generation, []);
    levels.get(entry.generation).push(entry);
  });

  const includedIds = new Set(included.keys());
  const couplePairs = [];
  const coupleKeys = new Set();
  const addCouple = (firstId, secondId) => {
    if (!includedIds.has(firstId) || !includedIds.has(secondId) || firstId === secondId) return;
    if (included.get(firstId)?.generation !== included.get(secondId)?.generation) return;
    const key = [firstId, secondId].sort().join(":");
    if (coupleKeys.has(key)) return;
    coupleKeys.add(key);
    couplePairs.push([firstId, secondId]);
  };

  activeRelations()
    .filter((relation) => relation.type === "spouse")
    .forEach((relation) => addCouple(relation.fromPersonId, relation.toPersonId));
  included.forEach((entry) => {
    const parents = getParentRelationsForChild(entry.person.id)
      .map((relation) => relation.fromPersonId)
      .filter((id) => includedIds.has(id));
    if (parents.length >= 2) addCouple(parents[0], parents[1]);
  });

  const makeUnits = (rows) => {
    const rowById = new Map(rows.map((entry) => [entry.person.id, entry]));
    const assigned = new Set();
    const units = [];
    couplePairs.forEach(([firstId, secondId]) => {
      if (!rowById.has(firstId) || !rowById.has(secondId) || assigned.has(firstId) || assigned.has(secondId)) return;
      let entries = [rowById.get(firstId), rowById.get(secondId)];
      if (entries[0].person.gender !== entries[1].person.gender) {
        // A stable male-left/female-right convention keeps each partner below
        // their own parental branch even when the female partner is the focus.
        entries.sort((a, b) => {
          if (a.person.gender === "male") return -1;
          if (b.person.gender === "male") return 1;
          return 0;
        });
      } else if (entries.some((entry) => entry.person.id === center.id)) {
        entries.sort((a, b) => {
          if (a.person.id === center.id) return -1;
          if (b.person.id === center.id) return 1;
          return 0;
        });
      }
      entries.forEach((entry) => assigned.add(entry.person.id));
      units.push({ entries, isCouple: true });
    });
    rows
      .filter((entry) => !assigned.has(entry.person.id))
      .forEach((entry) => units.push({ entries: [entry], isCouple: false }));
    return units;
  };

  const unitWidth = (unit) =>
    unit.entries.length * LOCAL_NODE_WIDTH + Math.max(0, unit.entries.length - 1) * LOCAL_COUPLE_GAP;
  const levelUnits = new Map();
  const generationValues = [...levels.keys()];
  const maxVisibleGeneration = Math.max(0, ...generationValues);
  const minVisibleGeneration = Math.min(0, ...generationValues);
  let widestRow = 0;
  for (let generation = maxVisibleGeneration; generation >= minVisibleGeneration; generation -= 1) {
    const units = makeUnits(levels.get(generation) || []);
    levelUnits.set(generation, units);
    widestRow = Math.max(
      widestRow,
      units.reduce((sum, unit) => sum + unitWidth(unit), 0) +
        Math.max(0, units.length - 1) * LOCAL_UNIT_GAP,
    );
  }

  const width = Math.max(920, widestRow + 120);
  const height = (maxVisibleGeneration - minVisibleGeneration + 1) * LOCAL_ROW_STEP + 58;
  const nodes = [];
  const positioned = new Map();
  const relationRows = activeRelations().filter((relation) => relation.type === "parent");

  const unitAnchor = (unit, generation) => {
    const memberIds = new Set(unit.entries.map((entry) => entry.person.id));
    const adjacentIds =
      generation > 0
        ? relationRows
            .filter((relation) => memberIds.has(relation.fromPersonId))
            .map((relation) => relation.toPersonId)
        : relationRows
            .filter((relation) => memberIds.has(relation.toPersonId))
            .map((relation) => relation.fromPersonId);
    const anchors = adjacentIds.map((id) => positioned.get(id)).filter(Boolean);
    if (!anchors.length) return null;
    return anchors.reduce((sum, node) => sum + node.x + LOCAL_NODE_WIDTH / 2, 0) / anchors.length;
  };

  const layoutOrder = [
    0,
    ...Array.from({ length: maxVisibleGeneration }, (_, index) => index + 1),
    ...Array.from({ length: Math.abs(minVisibleGeneration) }, (_, index) => -(index + 1)),
  ];

  layoutOrder.forEach((generation) => {
    const units = levelUnits.get(generation) || [];
    if (generation === 0) {
      const centerIndex = units.findIndex((unit) => unit.entries.some((entry) => entry.person.id === center.id));
      const centerUnit = centerIndex >= 0 ? units.splice(centerIndex, 1)[0] : null;
      units.sort((a, b) => a.entries[0].person.name.localeCompare(b.entries[0].person.name, "zh-CN"));
      if (centerUnit) units.splice(Math.floor(units.length / 2), 0, centerUnit);
    } else {
      units.sort((a, b) => {
        const anchorA = unitAnchor(a, generation);
        const anchorB = unitAnchor(b, generation);
        if (anchorA !== null && anchorB !== null && anchorA !== anchorB) return anchorA - anchorB;
        if (anchorA !== null) return -1;
        if (anchorB !== null) return 1;
        return a.entries[0].person.name.localeCompare(b.entries[0].person.name, "zh-CN");
      });
    }

    const rowWidth =
      units.reduce((sum, unit) => sum + unitWidth(unit), 0) +
      Math.max(0, units.length - 1) * LOCAL_UNIT_GAP;
    let cursorX = width / 2 - rowWidth / 2;
    const y = 24 + (maxVisibleGeneration - generation) * LOCAL_ROW_STEP;
    units.forEach((unit) => {
      unit.entries.forEach((entry, index) => {
        const node = {
          type: "person",
          id: entry.person.id,
          person: entry.person,
          kind: entry.kind,
          x: cursorX + index * (LOCAL_NODE_WIDTH + LOCAL_COUPLE_GAP),
          y,
        };
        nodes.push(node);
        positioned.set(node.id, node);
      });
      cursorX += unitWidth(unit) + LOCAL_UNIT_GAP;
    });
  });

  const centerNode = nodes.find((node) => node.id === center.id);
  if (centerNode) {
    const centerDelta = width / 2 - (centerNode.x + LOCAL_NODE_WIDTH / 2);
    nodes.forEach((node) => {
      node.x += centerDelta;
    });
  }

  const edges = [];
  couplePairs.forEach(([firstId, secondId]) => {
    edges.push({ from: firstId, to: secondId, relationType: "couple" });
  });

  included.forEach((entry) => {
    const parentIds = getParentRelationsForChild(entry.person.id)
      .map((relation) => relation.fromPersonId)
      .filter((id) => includedIds.has(id));
    const pairedParents = couplePairs.find(
      ([firstId, secondId]) => parentIds.includes(firstId) && parentIds.includes(secondId),
    );
    if (pairedParents) {
      edges.push({ parents: pairedParents, to: entry.person.id, relationType: "family" });
    } else {
      parentIds.forEach((parentId) => {
        edges.push({ from: parentId, to: entry.person.id, relationType: "parent" });
      });
    }
  });

  activeRelations()
    .filter(
      (relation) =>
        relation.type === "sibling" &&
        relation.toPersonId === center.id &&
        includedIds.has(relation.fromPersonId),
    )
    .forEach((relation) => {
      const siblingParents = new Set(
        getParentRelationsForChild(relation.fromPersonId).map((parentRelation) => parentRelation.fromPersonId),
      );
      const sharesVisibleParent = getParentRelationsForChild(center.id).some(
        (parentRelation) =>
          siblingParents.has(parentRelation.fromPersonId) && includedIds.has(parentRelation.fromPersonId),
      );
      if (!sharesVisibleParent) {
        edges.push({ from: relation.fromPersonId, to: center.id, relationType: "sibling" });
      }
    });

  return { nodes, edges, width, height };
}

function renderLocalKinshipPage(routeId) {
  const center = routeId ? getPerson(routeId) : getFocusPerson();
  if (!center) return renderMissing("请先创建一位成员，再查看局部谱。", true);
  state.highlightedId = center.id;
  const graph = buildLocalKinshipGraph(center.id, 3);
  return `
    <section class="section local-kinship-page">
      <div class="toolbar">
        <div>
          <h2>三代局部谱</h2>
          <p class="muted">以 ${escapeHtml(center.name)} 为中心，向上三代、向下三代；点击任意成员可重新居中。</p>
        </div>
        <div class="actions">
          <button data-go="/">家族星图</button>
          <button data-go="/persons/${center.id}">成员资料</button>
        </div>
      </div>
      ${renderTreeSearch()}
      <div class="local-generation-guide">
        <strong>图中由上至下</strong>
        <span>上三代</span><span>上二代</span><span>上一代</span><span>同辈</span><span>下一代</span><span>下二代</span><span>下三代</span>
      </div>
      <div class="local-line-legend" aria-label="关系线说明">
        <span><i class="parent"></i>生育线</span>
        <span><i class="couple"></i>婚姻线</span>
        <span><i class="sibling"></i>兄弟姐妹</span>
        <span><i class="alive"></i>健在</span>
        <span><i class="deceased"></i>已故</span>
      </div>
      <div class="local-kinship-wrap" id="local-kinship-wrap">
        <div class="local-kinship-canvas" id="local-kinship-canvas" style="width:${graph.width}px; height:${graph.height}px">
          <svg class="local-edge-layer" viewBox="0 0 ${graph.width} ${graph.height}" style="width:${graph.width}px; height:${graph.height}px" aria-hidden="true">
            ${graph.edges.map((edge) => renderLocalKinshipEdge(edge, graph.nodes)).join("")}
          </svg>
          ${graph.nodes.map((node) => renderLocalKinshipNode(node, center.id)).join("")}
        </div>
      </div>
    </section>
  `;
}

function renderLocalKinshipNode(node, centerId) {
  return `
    <button
      class="local-person-node ${node.person.gender} ${node.person.isAlive ? "alive" : "deceased"} ${node.person.id === centerId ? "center" : ""} ${node.kind || ""}"
      style="left:${node.x}px; top:${node.y}px"
      data-go="/tree/local/${node.person.id}"
      title="点击以此人为中心"
    >
      <strong>${escapeHtml(node.person.name)}</strong>
      ${node.kind === "spouse" ? "<span>配偶</span>" : node.kind === "sibling" ? "<span>兄弟姐妹</span>" : ""}
    </button>
  `;
}

function renderLocalKinshipEdge(edge, nodes) {
  if (edge.relationType === "family") {
    const firstParent = nodes.find((node) => node.id === edge.parents[0]);
    const secondParent = nodes.find((node) => node.id === edge.parents[1]);
    const child = nodes.find((node) => node.id === edge.to);
    if (!firstParent || !secondParent || !child) return "";
    const sourceX = (firstParent.x + secondParent.x) / 2 + LOCAL_NODE_WIDTH / 2;
    const sourceY = firstParent.y < child.y ? firstParent.y + LOCAL_NODE_HEIGHT : firstParent.y;
    const childX = child.x + LOCAL_NODE_WIDTH / 2;
    const childY = firstParent.y < child.y ? child.y : child.y + LOCAL_NODE_HEIGHT;
    return `<path class="local-edge parent" d="M ${sourceX} ${sourceY} L ${childX} ${childY}" />`;
  }

  const from = nodes.find((node) => node.id === edge.from);
  const to = nodes.find((node) => node.id === edge.to);
  if (!from || !to) return "";
  if (edge.relationType === "couple") {
    const left = from.x <= to.x ? from : to;
    const right = from.x <= to.x ? to : from;
    return `<path class="local-edge couple" d="M ${left.x + LOCAL_NODE_WIDTH} ${left.y + LOCAL_NODE_HEIGHT / 2} H ${right.x}" />`;
  }
  const a = {
    x: from.x + LOCAL_NODE_WIDTH / 2,
    y: from.y + LOCAL_NODE_HEIGHT / 2,
  };
  const b = {
    x: to.x + LOCAL_NODE_WIDTH / 2,
    y: to.y + LOCAL_NODE_HEIGHT / 2,
  };
  if (Math.abs(a.y - b.y) < 4) {
    return `<path class="local-edge ${escapeAttr(edge.relationType)}" d="M ${a.x} ${a.y} H ${b.x}" />`;
  }
  const fromY = from.y < to.y ? from.y + LOCAL_NODE_HEIGHT : from.y;
  const toY = from.y < to.y ? to.y : to.y + LOCAL_NODE_HEIGHT;
  return `<path class="local-edge ${escapeAttr(edge.relationType)}" d="M ${a.x} ${fromY} L ${b.x} ${toY}" />`;
}

function renderTreePage(routeId) {
  const self = getFocusPerson();
  if (!self) return renderMissing("请先创建一位成员，再查看家谱树。", true);

  const center = routeId ? getPerson(routeId) : self;
  if (!center) return renderMissing("没有找到中心人物。");

  const relations = getRelationsFor(center.id);
  const familyUnits = getFamilyUnitsFor(center.id);
  return `
    <section class="section">
      <div class="toolbar">
        <div>
          <h2>局部主轴树</h2>
          <p class="muted">当前中心：${escapeHtml(center.name)}</p>
        </div>
        <div class="actions">
          <button data-go="/tree/local/${self.id}">回到观察中心</button>
          <button data-go="/persons/${center.id}">☷ 查看详情</button>
          <button data-go="/" data-highlight="${center.id}">在星图中查看</button>
        </div>
      </div>
      ${renderTreeSearch()}
      <div class="tree-wrap">
        <div class="tree-axis">
          <div class="parents-layer">
            ${relations.father ? renderTreeNode(relations.father) : renderEmptyTreeNode("父亲")}
            ${relations.mother ? renderTreeNode(relations.mother) : renderEmptyTreeNode("母亲")}
          </div>
          <div class="connector parents"></div>
          <div class="center-layer">
            <div class="center-slot">${renderTreeNode(center, true)}</div>
            <div class="spouse-slot">${relations.spouses.map((person) => renderTreeNode(person)).join("")}</div>
          </div>
          <div class="connector children"></div>
          <div class="family-units-layer">
            ${familyUnits.map((unit) => renderFamilyUnit(unit)).join("")}
          </div>
        </div>
      </div>
    </section>
  `;
}

function renderFamilyUnit(unit) {
  const expanded = state.expandedUnits.has(unit.id);
  const visibleChildren = expanded ? unit.children : unit.children.slice(0, CHILD_LIMIT);
  const hiddenCount = unit.children.length - visibleChildren.length;
  return `
    <section class="family-unit">
      <div class="family-unit-head">
        <strong>${escapeHtml(unit.label)}</strong>
        ${unit.spouse ? `<span class="tag">配偶：${escapeHtml(unit.spouse.name)}</span>` : `<span class="tag">未关联配偶</span>`}
      </div>
      <div class="children-layer family-children">
        ${
          visibleChildren.length
            ? visibleChildren.map((person) => renderTreeNode(person)).join("")
            : `<article class="person-card tree-node empty"><strong>子女</strong><span>暂无记录</span></article>`
        }
        ${
          hiddenCount > 0
            ? `<button class="more-node" data-toggle-unit="${unit.id}">还有 ${hiddenCount} 个子女，点击展开</button>`
            : unit.children.length > CHILD_LIMIT
              ? `<button class="more-node" data-toggle-unit="${unit.id}">收起子女</button>`
              : ""
        }
      </div>
    </section>
  `;
}

function renderGlobalTreePage() {
  const self = getFocusPerson();
  if (!self) return renderMissing("请先创建一位成员，再查看全局图。", true);

  const graph = buildGlobalGraph(state.highlightedId || self.id);
  return `
    <section class="section">
      <div class="toolbar">
        <div>
          <h2>二维全局关系图</h2>
          <p class="muted">以当前成员为中心，展示所有已连接亲属；可拖动画布、缩放和搜索切换中心。</p>
        </div>
        <div class="actions">
          <button data-global-home>回到观察中心</button>
          <button data-zoom="out">− 缩小</button>
          <button data-zoom="in">＋ 放大</button>
          <button data-zoom="fit">适配</button>
        </div>
      </div>
      ${renderTreeSearch()}
      <div class="global-wrap" id="global-wrap">
        <div class="global-canvas" id="global-canvas" style="width:${graph.width}px; height:${graph.height}px; transform: translate(${state.globalView.x}px, ${state.globalView.y}px) scale(${state.globalView.scale})">
          <svg class="global-edge-layer" viewBox="0 0 ${graph.width} ${graph.height}" style="width:${graph.width}px; height:${graph.height}px" aria-hidden="true">
            ${graph.edges.map((edge) => renderGlobalEdge(edge, graph.nodes)).join("")}
          </svg>
          ${graph.nodes.map(renderGlobalNode).join("")}
        </div>
      </div>
    </section>
  `;
}

function buildGlobalGraphLegacy(centerId) {
  const self = getFocusPerson();
  const root = getPerson(centerId) || self;
  const nodes = [];
  const edges = [];
  const seen = new Set();

  function addPerson(person, x, y, depthLabel = "") {
    if (!person || seen.has(person.id)) return;
    seen.add(person.id);
    nodes.push({ type: "person", id: person.id, person, x, y, depthLabel });
  }

  function addUnit(id, label, x, y, collapsedText = "", toggleId = "") {
    if (seen.has(id)) return;
    seen.add(id);
    nodes.push({ type: "unit", id, label, x, y, collapsedText, toggleId });
  }

  function edge(from, to) {
    edges.push({ from, to });
  }

  addPerson(root, 0, 170, "中心");
  const rel = getRelationsFor(root.id);
  const father = rel.father;
  const mother = rel.mother;
  addPerson(father, -180, 10, "上1代");
  addPerson(mother, 180, 10, "上1代");
  if (father) edge(father.id, root.id);
  if (mother) edge(mother.id, root.id);

  [father, mother].filter(Boolean).forEach((parent, parentIndex) => {
    const parentRel = getRelationsFor(parent.id);
    const grandY = -150;
    const baseX = parentIndex === 0 ? -300 : 300;
    if (parentRel.father) {
      addPerson(parentRel.father, baseX - 80, grandY, "上2代");
      edge(parentRel.father.id, parent.id);
    }
    if (parentRel.mother) {
      addPerson(parentRel.mother, baseX + 80, grandY, "上2代");
      edge(parentRel.mother.id, parent.id);
    }
  });

  rel.spouses.forEach((spouse, index) => {
    const x = 260 + index * 190;
    addPerson(spouse, x, 170, "配偶");
  });

  const units = getFamilyUnitsFor(root.id);
  units.forEach((unit, unitIndex) => {
    const unitId = `global-unit:${unit.id}`;
    const x = (unitIndex - (units.length - 1) / 2) * 260;
    addUnit(
      unitId,
      unit.spouse ? `与 ${unit.spouse.name}` : "未知另一方",
      x,
      330,
      unit.children.length > CHILD_LIMIT ? `+${unit.children.length - CHILD_LIMIT} 个子女` : "",
      unit.id,
    );
    edge(root.id, unitId);
    if (unit.spouse) edge(unit.spouse.id, unitId);
    const visible = state.expandedGlobal.has(unit.id) ? unit.children : unit.children.slice(0, CHILD_LIMIT);
    visible.forEach((child, childIndex) => {
      addPerson(child, x + (childIndex - (visible.length - 1) / 2) * 145, 500, "下1代");
      edge(unitId, child.id);
    });
    if (unit.children.length > visible.length) {
      const moreId = `more:${unit.id}`;
      addUnit(moreId, `+${unit.children.length - visible.length} 个子女`, x + 230, 500, "点击展开", unit.id);
      edge(unitId, moreId);
    }
  });

  nodes.forEach((node) => {
    node.x *= 0.68;
    node.y = 140 + (node.y - 170) * 0.72;
  });
  return { nodes, edges };
}

function buildGlobalGraph(centerId) {
  const root = getPerson(centerId) || getFocusPerson();
  if (!root) return { nodes: [], edges: [], width: 1280, height: 900 };

  const persons = new Map(activePersons().map((person) => [person.id, person]));
  const adjacency = new Map([...persons.keys()].map((id) => [id, []]));
  const edges = [];
  const edgeKeys = new Set();

  activeRelations().forEach((relation) => {
    if (!persons.has(relation.fromPersonId) || !persons.has(relation.toPersonId)) return;
    const undirected = relation.type === "spouse" || relation.type === "sibling";
    const edgeKey = undirected
      ? [relation.type, relation.fromPersonId, relation.toPersonId].sort().join(":")
      : `${relation.type}:${relation.fromPersonId}:${relation.toPersonId}:${relation.role}`;
    if (!edgeKeys.has(edgeKey)) {
      edgeKeys.add(edgeKey);
      edges.push({
        from: relation.fromPersonId,
        to: relation.toPersonId,
        relationType: relation.type,
      });
    }

    if (relation.type === "parent") {
      adjacency.get(relation.fromPersonId).push({ id: relation.toPersonId, generationDelta: -1 });
      adjacency.get(relation.toPersonId).push({ id: relation.fromPersonId, generationDelta: 1 });
    } else {
      adjacency.get(relation.fromPersonId).push({ id: relation.toPersonId, generationDelta: 0 });
      adjacency.get(relation.toPersonId).push({ id: relation.fromPersonId, generationDelta: 0 });
    }
  });

  const traversal = new Map([[root.id, { generation: 0, distance: 0 }]]);
  const queue = [root.id];
  while (queue.length) {
    const currentId = queue.shift();
    const current = traversal.get(currentId);
    (adjacency.get(currentId) || []).forEach((neighbor) => {
      if (traversal.has(neighbor.id)) return;
      traversal.set(neighbor.id, {
        generation: current.generation + neighbor.generationDelta,
        distance: current.distance + 1,
      });
      queue.push(neighbor.id);
    });
  }

  const levels = new Map();
  traversal.forEach((info, id) => {
    const person = persons.get(id);
    const generation = info.generation;
    if (!levels.has(generation)) levels.set(generation, []);
    levels.get(generation).push({ person, distance: info.distance });
  });

  const generationValues = [...levels.keys()];
  const maxGeneration = Math.max(...generationValues);
  const minGeneration = Math.min(...generationValues);
  const widestLevel = Math.max(...[...levels.values()].map((rows) => rows.length));
  const width = Math.max(1280, widestLevel * 112 + 180);
  const height = Math.max(900, (maxGeneration - minGeneration + 1) * 112 + 180);
  const generationGap = Math.min(112, (height - 180) / Math.max(1, maxGeneration - minGeneration));
  const nodes = [];

  [...levels.entries()]
    .sort(([a], [b]) => b - a)
    .forEach(([generation, rows]) => {
      rows.sort((a, b) => {
        if (a.person.id === root.id) return -1;
        if (b.person.id === root.id) return 1;
        return a.distance - b.distance || a.person.name.localeCompare(b.person.name, "zh-CN");
      });
      const rootIndex = rows.findIndex((row) => row.person.id === root.id);
      if (rootIndex >= 0) {
        const [rootRow] = rows.splice(rootIndex, 1);
        rows.splice(Math.floor(rows.length / 2), 0, rootRow);
      }
      const horizontalGap = Math.min(112, (width - 160) / Math.max(1, rows.length));
      const rowWidth = (rows.length - 1) * horizontalGap;
      const y = 80 + (maxGeneration - generation) * generationGap;
      rows.forEach((row, index) => {
        nodes.push({
          type: "person",
          id: row.person.id,
          person: row.person,
          x: width / 2 - rowWidth / 2 + index * horizontalGap - 43,
          y,
        });
      });
    });

  const connectedIds = new Set(traversal.keys());
  return {
    nodes,
    edges: edges.filter((edge) => connectedIds.has(edge.from) && connectedIds.has(edge.to)),
    width,
    height,
  };
}

function renderGlobalNode(node) {
  const style = `left:${node.x}px; top:${node.y}px`;
  if (node.type === "unit") {
    return `<button class="global-node unit-node" style="${style}" data-global-unit="${escapeAttr(node.toggleId || node.id)}">
      <strong>${escapeHtml(node.label)}</strong>
      ${node.collapsedText ? `<span>${escapeHtml(node.collapsedText)}</span>` : ""}
    </button>`;
  }

  const isHighlighted = node.person.id === state.highlightedId;
  return `<article class="global-node person-node ${node.person.gender} ${isHighlighted ? "highlight" : ""}" style="${style}" data-focus-person="${node.person.id}" title="点击以此人为中心">
    <strong>${escapeHtml(node.person.name)}</strong>
  </article>`;
}

function renderGlobalEdge(edge, nodes) {
  const from = nodes.find((node) => node.id === edge.from);
  const to = nodes.find((node) => node.id === edge.to);
  if (!from || !to) return "";
  const a = globalNodeCenter(from);
  const b = globalNodeCenter(to);
  const midY = a.y + (b.y - a.y) / 2;
  return `<path class="global-edge ${escapeAttr(edge.relationType || "parent")}" d="M ${a.x} ${a.y} V ${midY} H ${b.x} V ${b.y}" />`;
}

function globalNodeCenter(node) {
  if (node.type === "unit") return { x: node.x + 48, y: node.y + 24 };
  return { x: node.x + 43, y: node.y + 18 };
}

function renderGenerationDashboardPage() {
  const filter = state.generationSearch.trim();
  const persons = activePersons().filter((person) => {
    if (!filter) return true;
    return person.name.trim().startsWith(filter);
  });
  const groups = new Map();
  persons.forEach((person) => {
    const key = person.generationLevel === null || person.generationLevel === undefined ? "unknown" : String(person.generationLevel);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(person);
  });
  const orderedGroups = [...groups.entries()].sort(([a], [b]) => {
    if (a === "unknown") return 1;
    if (b === "unknown") return -1;
    return generationSortValue(b) - generationSortValue(a);
  });

  return `
    <section class="section">
      <div class="section-title dashboard-title">
        <div>
          <h2>辈分统计看板</h2>
          <p class="muted">按辈分级次、性别和姓氏整理现有成员</p>
        </div>
        <div class="search-row">
          <input id="generation-search" type="search" placeholder="按姓氏筛选，如：张" value="${escapeAttr(state.generationSearch)}" />
        </div>
      </div>
      <div class="dashboard-summary">
        <article><strong>${persons.length}</strong><span>当前匹配</span></article>
        <article><strong>${persons.filter((person) => person.gender === "male").length}</strong><span>男性</span></article>
        <article><strong>${persons.filter((person) => person.gender === "female").length}</strong><span>女性</span></article>
        <article><strong>${new Set(persons.map(getSurname).filter(Boolean)).size}</strong><span>姓氏数</span></article>
      </div>
      ${
        orderedGroups.length
          ? `<div class="generation-board">${orderedGroups
              .map(([level, group]) => renderGenerationGroup(level, group))
              .join("")}</div>`
          : `<div class="empty-state"><h3>没有匹配成员</h3><p class="muted">换一个姓氏，或先在成员表单里设置辈分级次。</p></div>`
      }
      ${renderFamilyMapV2(activePersons())}
    </section>
  `;
}

function renderFamilyMapV2(persons) {
  const located = persons.filter(
    (person) => Number.isFinite(person.geoLat) && Number.isFinite(person.geoLng) && person.geoLabel,
  );
  return `
    <details class="family-map-details" id="family-map-details">
      <summary>
        <span>地域分布（辅助）</span>
        <small>${located.length} 位成员已定位</small>
      </summary>
      <section class="family-map-section family-map-section-lite">
        <div class="generation-head">
          <div>
            <h3>家族地域分布</h3>
            <p class="muted">本地轻量展示，不加载外部地图底图；悬停光点可查看姓名与地点。</p>
          </div>
          <span class="map-legend"><i></i> 成员位置</span>
        </div>
        ${located.length ? renderFamilyMapSvg(located) : `<div class="map-fallback">还没有可展示的地理坐标。</div>`}
        <p class="map-note">散点按经纬度投影；同一地点多人会自动错开，便于观察家族地域分布。</p>
      </section>
    </details>
  `;
}

function renderFamilyMapSvg(located) {
  const bounds = getFamilyMapBounds(located);
  const locationCounts = new Map();
  const points = located.map((person) => {
    const key = `${person.geoLat.toFixed(4)},${person.geoLng.toFixed(4)}`;
    const index = locationCounts.get(key) || 0;
    locationCounts.set(key, index + 1);
    const angle = index * 2.399963;
    const radius = index === 0 ? 0 : 7 * Math.ceil(index / 6);
    const projected = projectFamilyMapPoint(person.geoLat, person.geoLng, bounds);
    return {
      person,
      x: projected.x + Math.cos(angle) * radius,
      y: projected.y + Math.sin(angle) * radius,
    };
  });
  return `
    <div class="family-map-lite" role="img" aria-label="家族成员地域散点图">
      <svg viewBox="0 0 900 360" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="mapGlow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stop-color="#ffffff" stop-opacity="1" />
            <stop offset="36%" stop-color="#70d7ff" stop-opacity="0.9" />
            <stop offset="100%" stop-color="#70d7ff" stop-opacity="0" />
          </radialGradient>
        </defs>
        <rect class="map-plane" x="24" y="24" width="852" height="312" rx="8"></rect>
        <path class="map-grid" d="M166 24V336 M308 24V336 M450 24V336 M592 24V336 M734 24V336 M24 102H876 M24 180H876 M24 258H876"></path>
        <text class="map-label" x="42" y="52">${escapeHtml(bounds.label)}</text>
        <text class="map-axis" x="42" y="322">${bounds.minLng.toFixed(1)}E</text>
        <text class="map-axis" x="805" y="322">${bounds.maxLng.toFixed(1)}E</text>
        <text class="map-axis" x="810" y="52">${bounds.maxLat.toFixed(1)}N</text>
        <text class="map-axis" x="810" y="310">${bounds.minLat.toFixed(1)}N</text>
        ${points
          .map(
            ({ person, x, y }) => `
              <g class="map-person-point ${person.gender}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})">
                <title>${escapeHtml(person.name)} - ${escapeHtml(person.geoLabel)}</title>
                <circle class="halo" r="12"></circle>
                <circle class="dot" r="3.8"></circle>
              </g>
            `,
          )
          .join("")}
      </svg>
    </div>
  `;
}

function getFamilyMapBounds(located) {
  const allInChina = located.every(
    (person) => person.geoLng >= 73 && person.geoLng <= 135 && person.geoLat >= 18 && person.geoLat <= 54,
  );
  if (allInChina) return { minLng: 73, maxLng: 135, minLat: 18, maxLat: 54, label: "中国范围" };
  const lngs = located.map((person) => person.geoLng);
  const lats = located.map((person) => person.geoLat);
  const minLng = Math.min(...lngs);
  const maxLng = Math.max(...lngs);
  const minLat = Math.min(...lats);
  const maxLat = Math.max(...lats);
  const lngPad = Math.max(3, (maxLng - minLng) * 0.18);
  const latPad = Math.max(3, (maxLat - minLat) * 0.18);
  return {
    minLng: Math.max(-180, minLng - lngPad),
    maxLng: Math.min(180, maxLng + lngPad),
    minLat: Math.max(-85, minLat - latPad),
    maxLat: Math.min(85, maxLat + latPad),
    label: "全球范围",
  };
}

function projectFamilyMapPoint(lat, lng, bounds) {
  const x = 42 + ((lng - bounds.minLng) / Math.max(1, bounds.maxLng - bounds.minLng)) * 816;
  const y = 318 - ((lat - bounds.minLat) / Math.max(1, bounds.maxLat - bounds.minLat)) * 276;
  return {
    x: Math.max(34, Math.min(866, x)),
    y: Math.max(34, Math.min(326, y)),
  };
}

function renderFamilyMap(persons) {
  const located = persons.filter(
    (person) => Number.isFinite(person.geoLat) && Number.isFinite(person.geoLng) && person.geoLabel,
  );
  return `
    <details class="family-map-details" id="family-map-details">
      <summary>
        <span>地域分布（辅助）</span>
        <small>${located.length} 位成员已定位</small>
      </summary>
      <section class="family-map-section">
        <div class="generation-head">
          <div>
            <h3>家族地域分布</h3>
            <p class="muted">用于辅助观察家族成员的地域流动</p>
          </div>
          <span class="map-legend"><i></i> 成员位置</span>
        </div>
        <div id="family-map" class="family-map" data-map-person-count="${located.length}"></div>
        <p class="map-note">地点搜索与底图数据来自 OpenStreetMap。地图只展示已保存的坐标。</p>
      </section>
    </details>
  `;
}

function bindDashboardMapDisclosure() {
  // The dashboard map is rendered as local SVG, so no external map runtime is needed.
}

function ensureLeafletLoaded() {
  if (window.L) return Promise.resolve();
  if (leafletLoadPromise) return leafletLoadPromise;
  leafletLoadPromise = new Promise((resolve, reject) => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.css";
    document.head.appendChild(link);

    const script = document.createElement("script");
    script.src = "https://unpkg.com/leaflet@1.9.4/dist/leaflet.js";
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
  return leafletLoadPromise;
}

async function initializeDashboardMap() {
  const mapNode = document.getElementById("family-map");
  if (!mapNode) return;
  if (!window.L) {
    mapNode.innerHTML = `<div class="map-fallback">正在加载地图组件...</div>`;
    try {
      await ensureLeafletLoaded();
    } catch {
      if (mapNode.isConnected) {
        mapNode.innerHTML = `<div class="map-fallback">地图组件未能加载。请检查网络连接，成员的地理标签仍会正常保存。</div>`;
      }
      return;
    }
    if (!mapNode.isConnected) return;
    mapNode.innerHTML = "";
  }

  const filter = state.generationSearch.trim();
  const located = activePersons().filter(
    (person) =>
      (!filter || person.name.trim().startsWith(filter)) &&
      Number.isFinite(person.geoLat) &&
      Number.isFinite(person.geoLng) &&
      person.geoLabel,
  );
  const map = L.map(mapNode, { zoomControl: true, attributionControl: true }).setView([35, 104], 3);
  L.tileLayer(MAP_TILE_URL, {
    maxZoom: 18,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);

  const locationCounts = new Map();
  const bounds = [];
  located.forEach((person) => {
    const key = `${person.geoLat.toFixed(4)},${person.geoLng.toFixed(4)}`;
    const index = locationCounts.get(key) || 0;
    locationCounts.set(key, index + 1);
    const angle = index * 2.399963;
    const radius = index === 0 ? 0 : 0.035 * Math.ceil(index / 6);
    const lat = person.geoLat + Math.sin(angle) * radius;
    const lng = person.geoLng + Math.cos(angle) * radius;
    bounds.push([lat, lng]);
    L.circleMarker([lat, lng], {
      radius: 4,
      weight: 1,
      color: person.gender === "female" ? "#c94f7c" : "#2d78b7",
      fillColor: person.gender === "female" ? "#ff8fb5" : "#5da9e9",
      fillOpacity: 0.9,
    })
      .bindTooltip(`<strong>${escapeHtml(person.name)}</strong><br>${escapeHtml(person.geoLabel)}`, {
        direction: "top",
        opacity: 0.94,
      })
      .addTo(map);
  });

  if (bounds.length === 1) map.setView(bounds[0], 7);
  if (bounds.length > 1) map.fitBounds(bounds, { padding: [28, 28], maxZoom: 7 });
}

function renderGenerationGroup(levelKey, persons) {
  const level = levelKey === "unknown" ? null : Number(levelKey);
  const males = persons.filter((person) => person.gender === "male");
  const females = persons.filter((person) => person.gender === "female");
  return `
    <section class="generation-group">
      <div class="generation-head">
        <div>
          <h3>${escapeHtml(formatGenerationLevel(level))}</h3>
          <p class="muted">共 ${persons.length} 人，男 ${males.length} 人，女 ${females.length} 人</p>
        </div>
        <span class="generation-badge">${level === null ? "待归类" : level > 0 ? `+${level}` : level}</span>
      </div>
      <div class="gender-columns">
        ${renderGenderColumn("男", males, "male")}
        ${renderGenderColumn("女", females, "female")}
      </div>
    </section>
  `;
}

function renderGenderColumn(title, persons, gender) {
  return `
    <div class="gender-column ${gender}">
      <div class="gender-column-head">
        <strong>${title}</strong>
        <span>${persons.length} 人</span>
      </div>
      ${
        persons.length
          ? `<div class="generation-persons">${persons
              .map(
                (person) => `
                  <button class="generation-person ${person.gender}" data-go="/persons/${person.id}">
                    <strong>${escapeHtml(person.name)}</strong>
                    <span>${escapeHtml(formatBirthTime(person))}</span>
                  </button>
                `,
              )
              .join("")}</div>`
          : `<p class="muted">暂无</p>`
      }
    </div>
  `;
}

function renderIncompletePage() {
  const rows = activePersons().map((person) => ({ person, missing: getMissingFields(person) })).filter((row) => row.missing.length);
  return `
    <section class="section">
      <div class="section-title">
        <div>
          <h2>待补充信息</h2>
          <p class="muted">共 ${rows.length} 位成员需要完善</p>
        </div>
      </div>
      ${
        rows.length
          ? `<div class="incomplete-list">${rows
              .map(
                ({ person, missing }) => `
                  <article class="incomplete-row">
                    <div>
                      <h3>${escapeHtml(person.name)}</h3>
                      <p class="muted">缺少：${missing.map(escapeHtml).join("、")}</p>
                    </div>
                    <div class="actions">
                      <button data-go="/persons/${person.id}">去补充</button>
                      <button data-go="/tree/local/${person.id}">局部定位</button>
                    </div>
                  </article>
                `,
              )
              .join("")}</div>`
          : `<div class="empty-state"><h3>目前没有明显缺口</h3><p class="muted">继续录入后，这里会列出缺出生时间、缺父母或占位成员。</p></div>`
      }
    </section>
  `;
}

function renderIncompletePageV2() {
  const rows = activePersons()
    .map((person) => ({ person, missing: getProfileMissingFields(person) }))
    .filter((row) => row.missing.length);
  return `
    <section class="section">
      <div class="section-title">
        <div>
          <h2>待补充信息</h2>
          <p class="muted">只检查辈分级次和地域标签，共 ${rows.length} 位成员需要补充</p>
        </div>
      </div>
      ${
        rows.length
          ? `<div class="incomplete-list">${rows
              .map(
                ({ person, missing }) => `
                  <article class="incomplete-row">
                    <div>
                      <h3>${escapeHtml(person.name)}</h3>
                      <p class="muted">待补充：${missing.map(escapeHtml).join("、")}</p>
                    </div>
                    <button data-modal="edit:${person.id}">去补充</button>
                  </article>
                `,
              )
              .join("")}</div>`
          : `<div class="empty-state"><h3>地域与辈分均已完善</h3><p class="muted">当前成员都可以参与辈分统计和地域地图展示。</p></div>`
      }
    </section>
  `;
}

function getProfileMissingFields(person) {
  const missing = [];
  if (person.generationLevel === null || person.generationLevel === undefined) missing.push("辈分");
  if (!person.geoLabel || !Number.isFinite(person.geoLat) || !Number.isFinite(person.geoLng)) missing.push("地域");
  return missing;
}

function getMissingFields(person) {
  const missing = [];
  const rel = getRelationsFor(person.id);
  if (person.isPlaceholder) missing.push("占位成员");
  if (!person.name || person.name.startsWith("未知")) missing.push("姓名");
  if (formatBirthTime(person) === "未填写") missing.push("出生时间");
  if (!rel.father) missing.push("父亲");
  if (!rel.mother) missing.push("母亲");
  if (!rel.spouses.length && rel.children.length) missing.push("可能缺另一方");
  return missing;
}

function renderMissing(message, showCreate = false) {
  return `
    <div class="empty-state">
      <h2>${escapeHtml(message)}</h2>
      ${showCreate ? `<button class="primary" data-go="/">创建第一位成员</button>` : `<button data-go="/">返回首页</button>`}
    </div>
  `;
}

function renderPersonForm({ id, person = null, relationType = null, submitText }) {
  const fixedGender =
    relationType === "father" ||
    relationType === "son" ||
    relationType === "olderBrother" ||
    relationType === "youngerBrother"
      ? "male"
      : relationType === "mother" ||
          relationType === "daughter" ||
          relationType === "olderSister" ||
          relationType === "youngerSister"
        ? "female"
        : null;
  const gender = fixedGender || person?.gender || "male";
  const birthTimeType = person?.birthTimeType || (person?.birthYear ? "exact" : "exact");
  const generationLevel = person?.generationLevel ?? "";
  const geoScope = person?.geoScope || "";
  return `
    <form class="form-panel" id="${id}" novalidate>
      <div class="form-grid">
        <div class="field">
          <label for="${id}-name">姓名</label>
          <input id="${id}-name" name="name" value="${escapeAttr(person?.name || "")}" />
          <div class="field-error" data-error-for="name"></div>
        </div>
        <div class="field">
          <label for="${id}-gender">性别</label>
          <select id="${id}-gender" name="gender" ${fixedGender ? "disabled" : ""}>
            <option value="male" ${gender === "male" ? "selected" : ""}>男</option>
            <option value="female" ${gender === "female" ? "selected" : ""}>女</option>
          </select>
        </div>
        <div class="field">
          <label for="${id}-generationLevel">辈分级次</label>
          <select id="${id}-generationLevel" name="generationLevel">
            <option value="" ${generationLevel === "" ? "selected" : ""}>未设置</option>
            ${[5, 4, 3, 2, 1, 0, -1, -2, -3, -4, -5]
              .map((level) => `<option value="${level}" ${Number(generationLevel) === level ? "selected" : ""}>${formatGenerationLevel(level)}</option>`)
              .join("")}
          </select>
        </div>
        <div class="field full geo-field">
          <label>地理标签</label>
          <div class="geo-controls">
            <select name="geoScope" aria-label="地区范围">
              <option value="" ${geoScope === "" ? "selected" : ""}>未设置</option>
              <option value="domestic" ${geoScope === "domestic" ? "selected" : ""}>国内</option>
              <option value="foreign" ${geoScope === "foreign" ? "selected" : ""}>国外</option>
            </select>
            <input
              name="geoQuery"
              placeholder="${geoScope === "foreign" ? "输入国家，如：日本" : "输入省、市、县，如：四川省成都市"}"
              value="${escapeAttr(person?.geoLabel || "")}"
            />
            <button type="button" data-geo-search>搜索地点</button>
          </div>
          <input type="hidden" name="geoLabel" value="${escapeAttr(person?.geoLabel || "")}" />
          <input type="hidden" name="geoLat" value="${person?.geoLat ?? ""}" />
          <input type="hidden" name="geoLng" value="${person?.geoLng ?? ""}" />
          <input type="hidden" name="geoCountry" value="${escapeAttr(person?.geoCountry || "")}" />
          <div class="geo-selected">${person?.geoLabel ? `已选择：${escapeHtml(person.geoLabel)}` : "未选择地点"}</div>
          <div class="geo-results" data-geo-results></div>
        </div>
        <div class="field full birth-field">
          <label>出生时间</label>
          <div class="segmented">
            <label><input type="radio" name="birthTimeType" value="exact" ${birthTimeType !== "approx" ? "checked" : ""} /> 精确年份</label>
            <label><input type="radio" name="birthTimeType" value="approx" ${birthTimeType === "approx" ? "checked" : ""} /> 模糊时间</label>
          </div>
          <div class="birth-input birth-exact">
            <input name="birthYear" inputmode="numeric" placeholder="请输入出生年份，如 1998" value="${escapeAttr(person?.birthYear || "")}" />
            <div class="field-error" data-error-for="birthYear"></div>
          </div>
          <div class="birth-input birth-approx">
            <input name="birthText" maxlength="20" placeholder="如：19世纪20年代、清末、约1930年" value="${escapeAttr(person?.birthText || "")}" />
            <div class="field-error" data-error-for="birthText"></div>
          </div>
        </div>
        <div class="field">
          <label>状态</label>
          <span class="checkbox-line">
            <input id="${id}-isAlive" name="isAlive" type="checkbox" ${person?.isAlive === false ? "" : "checked"} />
            <label for="${id}-isAlive">健在</label>
          </span>
        </div>
        <div class="field">
          <label>资料</label>
          <span class="checkbox-line">
            <input id="${id}-isPlaceholder" name="isPlaceholder" type="checkbox" ${person?.isPlaceholder ? "checked" : ""} />
            <label for="${id}-isPlaceholder">占位 / 待补充</label>
          </span>
        </div>
        <div class="field full">
          <label for="${id}-bio">简介</label>
          <textarea id="${id}-bio" name="bio">${escapeHtml(person?.bio || "")}</textarea>
        </div>
      </div>
      <div class="actions" style="margin-top: 14px">
        <button class="primary" type="submit">${submitText}</button>
      </div>
    </form>
  `;
}

function renderPersonCard(person, options = {}) {
  const click = options.detail ? `data-go="/persons/${person.id}"` : "";
  return `
    <article class="person-card ${person.gender} ${person.id === state.highlightedId ? "highlight" : ""} ${options.clickable === false ? "" : "clickable"}" ${click}>
      ${renderPersonSummary(person)}
    </article>
  `;
}

function renderTreeNode(person, isCenter = false) {
  return `
    <article class="person-card tree-node ${person.gender} ${isCenter ? "center" : ""} ${person.id === state.highlightedId ? "highlight" : ""} clickable" data-go="/tree/local/${person.id}">
      ${renderPersonSummary(person)}
      <button class="icon-only" title="查看详情" data-go="/persons/${person.id}">☷</button>
    </article>
  `;
}

function renderEmptyTreeNode(label) {
  return `<article class="person-card tree-node empty"><strong>${label}</strong><span>暂无记录</span></article>`;
}

function renderPersonSummary(person) {
  return `
    <div class="person-name">
      <span>${escapeHtml(person.name)}</span>
      ${person.isPlaceholder ? `<span class="tag">待补充</span>` : ""}
    </div>
    <div class="person-meta">
      ${person.geoLabel ? `<span class="tag">地点：${escapeHtml(person.geoLabel)}</span>` : ""}
      <span class="tag">辈分：${escapeHtml(formatGenerationLevel(person.generationLevel))}</span>
      <span class="tag">${person.gender === "female" ? "女" : "男"}</span>
      <span class="tag">出生时间：${escapeHtml(formatBirthTime(person))}</span>
      <span class="tag">${person.isAlive ? "健在" : "已故"}</span>
    </div>
  `;
}

function renderRelationSection(title, persons) {
  return `
    <section class="relation-section">
      <h3>${title}</h3>
      ${
        persons.length
          ? persons.map((person) => renderPersonCard(person, { detail: true })).join("")
          : `<p class="muted">暂无记录</p>`
      }
    </section>
  `;
}

function renderModal(modal) {
  const [type, id, relationType] = modal.split(":");
  if (type === "edit") {
    const person = getPerson(id);
    if (!person) return "";
    return `
      <div class="modal-backdrop" data-close-modal>
        <div class="modal" data-modal-panel>
          <div class="modal-head">
            <h2>编辑成员</h2>
            <button class="icon-only" data-close-modal title="关闭">×</button>
          </div>
          ${renderPersonForm({ id: "edit-form", person, submitText: "保存修改" })}
        </div>
      </div>
    `;
  }

  if (type === "relative") {
    const titleMap = { father: "添加父亲", mother: "添加母亲", son: "添加儿子", daughter: "添加女儿", spouse: "添加配偶" };
    return `
      <div class="modal-backdrop" data-close-modal>
        <div class="modal" data-modal-panel>
          <div class="modal-head">
            <h2>${titleMap[relationType] || "添加亲属"}</h2>
            <button class="icon-only" data-close-modal title="关闭">×</button>
          </div>
          ${renderPersonForm({ id: "relative-form", relationType, submitText: "添加" })}
        </div>
      </div>
    `;
  }

  if (type === "delete") {
    const person = getPerson(id);
    if (!person) return "";
    return `
      <div class="modal-backdrop" data-close-modal>
        <div class="modal" data-modal-panel>
          <div class="modal-head">
            <h2>删除成员</h2>
            <button class="icon-only" data-close-modal title="关闭">×</button>
          </div>
          <p class="muted">将软删除 ${escapeHtml(person.name)}，并停用所有相关关系记录。</p>
          <div class="actions" style="margin-top: 16px">
            <button class="danger" data-delete="${person.id}">确认删除</button>
            <button data-close-modal>取消</button>
          </div>
        </div>
      </div>
    `;
  }

  return "";
}

function bindEvents(root) {
  root.querySelector("[data-export-family]")?.addEventListener("click", exportFamilyData);
  root.querySelector("[data-import-family]")?.addEventListener("click", chooseFamilyDataImportFile);

  root.querySelector("[data-star-detail]")?.addEventListener("click", () => {
    const person = getFocusPerson();
    if (person) go(`/persons/${person.id}`);
  });

  root.querySelector("[data-star-local]")?.addEventListener("click", () => {
    const person = getFocusPerson();
    if (person) go(`/tree/local/${person.id}`);
  });

  root.querySelectorAll("[data-set-focus]").forEach((element) => {
    element.addEventListener("click", () => {
      state.highlightedId = element.getAttribute("data-set-focus");
      render();
    });
  });

  root.querySelectorAll("[data-go]").forEach((element) => {
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      const highlight = element.getAttribute("data-highlight");
      if (highlight) state.highlightedId = highlight;
      go(element.getAttribute("data-go"));
    });
  });

  root.querySelectorAll("[data-modal]").forEach((element) => {
    element.addEventListener("click", () => {
      state.modal = element.getAttribute("data-modal");
      render();
    });
  });

  root.querySelectorAll("[data-close-modal]").forEach((element) => {
    element.addEventListener("click", (event) => {
      if (event.target.hasAttribute("data-close-modal")) {
        state.modal = null;
        render();
      }
    });
  });

  root.querySelectorAll("[data-modal-panel]").forEach((element) => {
    element.addEventListener("click", (event) => event.stopPropagation());
  });

  root.querySelectorAll("form").forEach(bindPersonFormLiveValidation);

  const selfForm = root.querySelector("#self-form");
  if (selfForm) {
    selfForm.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        submitSelf(selfForm);
      } catch (error) {
        if (error.message !== "FORM_HAS_INLINE_ERRORS") notify(error.message);
      }
    });
  }

  const editForm = root.querySelector("#edit-form");
  if (editForm && state.modal?.startsWith("edit:")) {
    editForm.addEventListener("submit", (event) => {
      event.preventDefault();
      try {
        updatePerson(state.modal.split(":")[1], editForm);
      } catch (error) {
        if (error.message !== "FORM_HAS_INLINE_ERRORS") notify(error.message);
      }
    });
  }

  const relativeForm = root.querySelector("#relative-form");
  if (relativeForm && state.modal?.startsWith("relative:")) {
    relativeForm.addEventListener("submit", (event) => {
      event.preventDefault();
      const [, id, relationType] = state.modal.split(":");
      try {
        addRelative(id, relationType, relativeForm);
      } catch (error) {
        if (error.message !== "FORM_HAS_INLINE_ERRORS") notify(error.message);
      }
    });
  }

  root.querySelectorAll("[data-delete]").forEach((element) => {
    element.addEventListener("click", () => softDeletePerson(element.getAttribute("data-delete")));
  });

  const search = root.querySelector("#search");
  if (search) {
    let composing = false;
    let searchTimer = null;
    const applySearch = () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.search = search.value;
        render();
        restoreInputFocus("search");
      }, 180);
    };
    search.addEventListener("compositionstart", () => {
      composing = true;
    });
    search.addEventListener("compositionend", () => {
      composing = false;
      applySearch();
    });
    search.addEventListener("input", () => {
      if (!composing) applySearch();
    });
  }

  root.querySelector("#member-gender-filter")?.addEventListener("change", (event) => {
    state.memberGenderFilter = event.target.value;
    render();
  });

  root.querySelector("#member-generation-filter")?.addEventListener("change", (event) => {
    state.memberGenerationFilter = event.target.value;
    render();
  });

  const generationSearch = root.querySelector("#generation-search");
  if (generationSearch) {
    let composing = false;
    const applyGenerationSearch = () => {
      clearTimeout(state.generationSearchTimer);
      state.generationSearchTimer = setTimeout(() => {
        state.generationSearch = generationSearch.value;
        render();
        restoreInputFocus("generation-search");
      }, 220);
    };
    generationSearch.addEventListener("compositionstart", () => {
      composing = true;
    });
    generationSearch.addEventListener("compositionend", () => {
      composing = false;
      applyGenerationSearch();
    });
    generationSearch.addEventListener("input", () => {
      if (!composing) applyGenerationSearch();
    });
  }

  const treeSearch = root.querySelector("#tree-search");
  if (treeSearch) {
    treeSearch.addEventListener("input", () => {
      state.treeSearch = treeSearch.value;
      render();
      restoreInputFocus("tree-search");
    });
  }

  root.querySelectorAll("[data-focus-person]").forEach((element) => {
    element.addEventListener("click", () => {
      const id = element.getAttribute("data-focus-person");
      state.highlightedId = id;
      if (state.route.name === "globalTree") {
        centerGlobalView();
        render();
      } else {
        go(`/tree/local/${id}`);
      }
    });
  });

  root.querySelectorAll("[data-toggle-unit]").forEach((element) => {
    element.addEventListener("click", () => {
      const id = element.getAttribute("data-toggle-unit");
      state.expandedUnits.has(id) ? state.expandedUnits.delete(id) : state.expandedUnits.add(id);
      render();
    });
  });

  root.querySelectorAll("[data-global-unit]").forEach((element) => {
    element.addEventListener("click", () => {
      const id = element.getAttribute("data-global-unit");
      state.expandedGlobal.has(id) ? state.expandedGlobal.delete(id) : state.expandedGlobal.add(id);
      render();
    });
  });

  root.querySelectorAll("[data-zoom]").forEach((element) => {
    element.addEventListener("click", () => {
      const action = element.getAttribute("data-zoom");
      if (action === "in") state.globalView.scale = Math.min(1.8, state.globalView.scale + 0.15);
      if (action === "out") state.globalView.scale = Math.max(0.55, state.globalView.scale - 0.15);
      if (action === "fit") centerGlobalView();
      render();
    });
  });

  const home = root.querySelector("[data-global-home]");
  if (home) {
    home.addEventListener("click", () => {
      const self = getFocusPerson();
      state.highlightedId = self?.id || "";
      centerGlobalView();
      render();
    });
  }

  bindGlobalDrag(root.querySelector("#global-wrap"));
}

function bindPersonFormLiveValidation(form) {
  if (!form) return;
  const updateBirthMode = () => {
    const type = form.birthTimeType?.value || "exact";
    form.querySelector(".birth-exact")?.classList.toggle("hidden", type !== "exact");
    form.querySelector(".birth-approx")?.classList.toggle("hidden", type !== "approx");
  };
  updateBirthMode();
  form.querySelectorAll('input[name="birthTimeType"]').forEach((input) => input.addEventListener("change", updateBirthMode));
  ["birthYear", "birthText", "name"].forEach((name) => {
    form[name]?.addEventListener("input", () => {
      const errors = {};
      if (name === "name" && !form.name.value.trim()) errors.name = "请填写姓名";
      Object.assign(
        errors,
        validateBirthTime({
          birthTimeType: form.birthTimeType?.value || "exact",
          birthYear: form.birthYear?.value || "",
          birthText: form.birthText?.value || "",
        }),
      );
      showFormErrors(form, errors);
    });
  });

  const geoScope = form.geoScope;
  const geoQuery = form.geoQuery;
  if (geoScope && geoQuery) {
    geoScope.addEventListener("change", () => {
      geoQuery.placeholder = geoScope.value === "foreign" ? "输入国家，如：日本" : "输入省、市、县，如：四川省成都市";
      form.geoLabel.value = "";
      form.geoLat.value = "";
      form.geoLng.value = "";
      form.geoCountry.value = "";
      form.querySelector(".geo-selected").textContent = "未选择地点";
      form.querySelector("[data-geo-results]").innerHTML = "";
    });
    geoQuery.addEventListener("input", () => {
      if (geoQuery.value !== form.geoLabel.value) {
        form.geoLabel.value = "";
        form.geoLat.value = "";
        form.geoLng.value = "";
        form.geoCountry.value = "";
        form.querySelector(".geo-selected").textContent = "地点文字已修改，请重新搜索并选择。";
      }
    });
  }

  form.querySelector("[data-geo-search]")?.addEventListener("click", () => searchGeography(form));
  geoQuery?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      searchGeography(form);
    }
  });
}

async function searchGeography(form) {
  const scope = form.geoScope?.value || "";
  const query = form.geoQuery?.value.trim() || "";
  const resultsNode = form.querySelector("[data-geo-results]");
  if (!scope || !query || !resultsNode) {
    if (resultsNode) resultsNode.innerHTML = `<p class="field-error">请先选择国内或国外，并输入地点。</p>`;
    return;
  }

  resultsNode.innerHTML = `<p class="muted">正在搜索地点...</p>`;
  const params = new URLSearchParams({
    format: "jsonv2",
    q: scope === "domestic" ? `${query}, 中国` : query,
    limit: "6",
    addressdetails: "1",
    "accept-language": "zh-CN",
  });
  if (scope === "domestic") params.set("countrycodes", "cn");

  try {
    const response = await fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`);
    if (!response.ok) throw new Error("LOCATION_SEARCH_FAILED");
    let results = await response.json();
    if (scope === "foreign") {
      const countries = results.filter((result) => result.type === "country" || result.addresstype === "country");
      if (countries.length) results = countries;
    }
    renderGeographyResults(form, results.slice(0, 6));
  } catch {
    resultsNode.innerHTML = `<p class="field-error">地点服务暂时不可用。可以稍后重试，或先保留输入的地名。</p>`;
  }
}

function renderGeographyResults(form, results) {
  const resultsNode = form.querySelector("[data-geo-results]");
  if (!resultsNode) return;
  if (!results.length) {
    resultsNode.innerHTML = `<p class="muted">没有找到匹配地点，请补充省、市或县级名称后重试。</p>`;
    return;
  }

  resultsNode.innerHTML = results
    .map(
      (result, index) => `
        <button
          type="button"
          data-geo-result="${index}"
          data-label="${escapeAttr(result.display_name)}"
          data-lat="${escapeAttr(result.lat)}"
          data-lng="${escapeAttr(result.lon)}"
          data-country="${escapeAttr(result.address?.country || "")}"
        >${escapeHtml(result.display_name)}</button>
      `,
    )
    .join("");

  resultsNode.querySelectorAll("[data-geo-result]").forEach((button) => {
    button.addEventListener("click", () => {
      form.geoLabel.value = button.dataset.label;
      form.geoLat.value = button.dataset.lat;
      form.geoLng.value = button.dataset.lng;
      form.geoCountry.value = button.dataset.country;
      form.geoQuery.value = button.dataset.label;
      form.querySelector(".geo-selected").textContent = `已选择：${button.dataset.label}`;
      resultsNode.innerHTML = "";
    });
  });
}

function restoreInputFocus(id) {
  const input = document.getElementById(id);
  input?.focus();
  input?.setSelectionRange(input.value.length, input.value.length);
}

function centerGlobalView() {
  state.globalView = { ...state.globalView, scale: 1, x: 0, y: 0, dragging: false };
  state.centerGlobalRequested = true;
}

function centerLocalKinshipView() {
  const wrap = document.getElementById("local-kinship-wrap");
  const center = document.querySelector(".local-person-node.center");
  if (!wrap || !center) return;
  wrap.scrollLeft = Math.max(0, center.offsetLeft + center.offsetWidth / 2 - wrap.clientWidth / 2);
  wrap.scrollTop = Math.max(0, center.offsetTop + center.offsetHeight / 2 - wrap.clientHeight / 2);
}

function centerGlobalCanvasOnFocus() {
  const wrap = document.getElementById("global-wrap");
  const canvas = document.getElementById("global-canvas");
  const focusId = state.highlightedId || getFocusPerson()?.id;
  if (!wrap || !canvas || !focusId) return;
  const node = [...canvas.querySelectorAll("[data-focus-person]")].find(
    (element) => element.getAttribute("data-focus-person") === focusId,
  );
  if (!node) return;
  const scale = state.globalView.scale;
  state.globalView.x = wrap.clientWidth / 2 - (node.offsetLeft + node.offsetWidth / 2) * scale;
  state.globalView.y = wrap.clientHeight / 2 - (node.offsetTop + node.offsetHeight / 2) * scale;
  canvas.style.transform = `translate(${state.globalView.x}px, ${state.globalView.y}px) scale(${scale})`;
  state.centerGlobalRequested = false;
}

function bindGlobalDrag(wrap) {
  if (!wrap) return;
  wrap.addEventListener("mousedown", (event) => {
    state.globalView.dragging = true;
    state.globalView.startX = event.clientX - state.globalView.x;
    state.globalView.startY = event.clientY - state.globalView.y;
    wrap.classList.add("dragging");
  });
  window.onmousemove = (event) => {
    if (!state.globalView.dragging) return;
    state.globalView.x = event.clientX - state.globalView.startX;
    state.globalView.y = event.clientY - state.globalView.startY;
    const canvas = document.getElementById("global-canvas");
    if (canvas) canvas.style.transform = `translate(${state.globalView.x}px, ${state.globalView.y}px) scale(${state.globalView.scale})`;
  };
  window.onmouseup = () => {
    state.globalView.dragging = false;
    wrap.classList.remove("dragging");
  };
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

if (reconcileFamilyRelations()) saveData();
render();
