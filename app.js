"use strict";

const API_URL = "https://script.google.com/macros/s/AKfycbysXv2itMmKabPAz4WFiakBjWIvqHvfEQVyb8_At0oAuUNyFZgeSg-BlMue4zyYu-2YwA/exec";
const APP_VERSION = "1.1";
const DB_NAME = "diario-bordo-offline";
const DB_VERSION = 1;
const $ = id => document.getElementById(id);
const escapeHtml = value => String(value == null ? "" : value).replace(/[&<>"]/g, c => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;"
})[c]);
const dateTimeNow = () => {
  const date = new Date();
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
};
const meterName = meter => meter === "HR" ? "Horímetro" : "KM";

let auth = null;
let dbPromise = null;
let records = [];
let editing = null;
let signatureData = "";
let drawing = false;
let refreshBusy = false;
let syncBusy = false;
let deferredInstallPrompt = null;

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === "x" ? r : (r & 3 | 8)).toString(16);
  });
}

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains("records")) {
        database.createObjectStore("records", { keyPath: "key" });
      }
      if (!database.objectStoreNames.contains("inventory")) {
        database.createObjectStore("inventory", { keyPath: "codigo" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Não foi possível abrir o armazenamento offline."));
  });
  return dbPromise;
}

async function storePut(storeName, value) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).put(value);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Não foi possível salvar no aparelho."));
    transaction.onabort = () => reject(transaction.error || new Error("A gravação local foi cancelada."));
  });
}

async function storeDelete(storeName, key) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    transaction.objectStore(storeName).delete(key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Não foi possível remover do aparelho."));
  });
}

async function storeGetAll(storeName) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = transaction.objectStore(storeName).getAll();
    request.onsuccess = () => resolve(request.result || []);
    request.onerror = () => reject(request.error || new Error("Não foi possível ler os dados locais."));
  });
}

async function replaceInventory(items) {
  const database = await openDatabase();
  return new Promise((resolve, reject) => {
    const transaction = database.transaction("inventory", "readwrite");
    const store = transaction.objectStore("inventory");
    store.clear();
    items.forEach(item => store.put(item));
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error("Não foi possível guardar o inventário no aparelho."));
  });
}

function appOriginAllowed(origin) {
  try {
    const host = new URL(origin).hostname;
    return host === "script.google.com"
      || host === "script.googleusercontent.com"
      || host.endsWith("-script.googleusercontent.com");
  } catch (error) {
    return false;
  }
}

function postApi(action, data) {
  return new Promise((resolve, reject) => {
    const nonce = uuid();
    const frameName = "api_" + nonce.replace(/-/g, "");
    const frame = document.createElement("iframe");
    frame.name = frameName;
    frame.title = "Conexão com a planilha";
    frame.className = "apiFrame";

    const form = document.createElement("form");
    form.method = "POST";
    form.action = API_URL;
    form.target = frameName;
    form.enctype = "application/x-www-form-urlencoded";
    form.className = "apiFrame";

    const field = document.createElement("input");
    field.type = "hidden";
    field.name = "payload";
    field.value = JSON.stringify(Object.assign({ action: action, nonce: nonce }, data || {}));
    form.appendChild(field);

    let timer;
    const finish = (error, value) => {
      window.removeEventListener("message", onMessage);
      window.clearTimeout(timer);
      form.remove();
      frame.remove();
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = event => {
      if (!appOriginAllowed(event.origin)) return;
      const message = event.data;
      if (!message || message.channel !== "diario-bordo-api" || message.nonce !== nonce) return;
      if (!message.ok) finish(new Error(message.error || "A planilha recusou a solicitação."));
      else finish(null, message.data);
    };

    window.addEventListener("message", onMessage);
    document.body.append(frame, form);
    timer = window.setTimeout(() => {
      finish(new Error("A planilha não confirmou a operação. O registro ficará salvo no aparelho para nova tentativa."));
    }, 45000);
    try {
      form.submit();
    } catch (error) {
      finish(error);
    }
  });
}

function setAuth(value) {
  auth = value;
  if (value) localStorage.setItem("diario-bordo-auth", JSON.stringify(value));
  else localStorage.removeItem("diario-bordo-auth");
}

function showLogin(message) {
  $("loginView").classList.remove("hidden");
  $("appView").classList.add("hidden");
  $("formView").classList.add("hidden");
  $("loginMsg").textContent = message || "";
}

function showApp() {
  $("loginView").classList.add("hidden");
  $("formView").classList.add("hidden");
  $("appView").classList.remove("hidden");
  $("who").textContent = "Conectado: " + auth.nome + (auth.admin ? " · Administrador" : "");
}

function setNotice(text, isError) {
  $("appMsg").textContent = text || "";
  $("appMsg").classList.toggle("error", !!isError);
}

async function getVisibleRecords() {
  const all = await storeGetAll("records");
  return all.filter(record => record.syncState !== "pending" || record.syncUser === auth.usuario);
}

async function updateNetworkStatus() {
  const all = auth ? await storeGetAll("records") : [];
  const pending = auth ? all.filter(record => record.syncState === "pending" && record.syncUser === auth.usuario).length : 0;
  const status = $("networkStatus");
  status.className = "status";
  if (!navigator.onLine) {
    status.textContent = pending
      ? "Offline · " + pending + " registro(s) aguardando envio. Eles permanecem salvos neste aparelho."
      : "Offline · novos registros serão guardados neste aparelho.";
    status.classList.add("offline");
  } else if (pending) {
    status.textContent = "Conectado · " + pending + " registro(s) aguardando sincronização.";
    status.classList.add("pending");
  } else {
    status.textContent = "Conectado · registros sincronizados com a planilha.";
  }
}

async function renderRecords() {
  if (!auth) return;
  records = await getVisibleRecords();
  const vehicles = Array.from(new Set(records.map(r => (r.veiculo || "") + " · " + (r.placa || "")))).sort();
  const filter = $("vehicleFilter");
  const previous = filter.value;
  filter.innerHTML = '<option value="">Todos os veículos</option>' +
    vehicles.map(v => '<option value="' + escapeHtml(v) + '">' + escapeHtml(v) + "</option>").join("");
  filter.value = vehicles.includes(previous) ? previous : "";
  $("vehicleOptions").innerHTML = Array.from(new Set(records.map(r => r.veiculo).filter(Boolean)))
    .map(v => '<option value="' + escapeHtml(v) + '">').join("");

  const month = $("monthFilter").value;
  const visible = records.filter(r =>
    (!filter.value || (r.veiculo + " · " + r.placa) === filter.value)
    && (!month || String(r.saida || "").slice(0, 7) === month)
  ).sort((a, b) => String(b.saida || "").localeCompare(String(a.saida || "")));

  if (!visible.length) {
    $("records").innerHTML = '<div class="empty">Nenhum registro salvo neste aparelho.</div>';
  } else {
    $("records").innerHTML = visible.map(recordCard).join("");
  }
  await updateNetworkStatus();
}

function formatDate(value) {
  if (!value) return "–";
  const parts = value.split("T");
  const date = parts[0].split("-");
  return date[2] + "/" + date[1] + "/" + date[0] + " " + (parts[1] || "");
}

function canEdit(record) {
  if (auth.admin) return navigator.onLine || record.localOwnerUser === auth.usuario;
  if (record.syncState === "pending") return record.syncUser === auth.usuario;
  if (record.criadoPor !== auth.usuario || record.chegada) return false;
  return navigator.onLine || record.localOwnerUser === auth.usuario;
}

function recordCard(record) {
  const done = !!record.chegada;
  const canEditRecord = canEdit(record);
  const pending = record.syncState === "pending";
  const badge = pending ? "Pendente de envio" : (done ? "Concluída" : "Em viagem");
  const badgeClass = done && !pending ? "badge done" : "badge";
  const signature = /^data:image\/png;base64,/.test(record.assinatura || "")
    ? '<div><img class="signatureImage" alt="Assinatura" src="' + record.assinatura + '"></div>' : "";
  const delta = record.valorFim !== "" && record.valorFim != null && record.valorIni !== ""
    ? '<br><b>' + escapeHtml(Number(record.valorFim) - Number(record.valorIni)) + " " + escapeHtml(record.medidor) + " percorridos</b>" : "";
  const error = record.syncError ? '<br><span class="error">' + escapeHtml(record.syncError) + "</span>" : "";
  const actions = (canEditRecord || (auth.admin && navigator.onLine))
    ? '<div class="actions">'
      + (canEditRecord ? '<button class="primary" data-edit="' + escapeHtml(record.key) + '">' + (done ? "Editar" : "Registrar chegada") + "</button>" : "")
      + (auth.admin && navigator.onLine ? '<button class="secondary danger" data-delete="' + escapeHtml(record.key) + '">Excluir</button>' : "")
      + "</div>" : "";

  return '<article class="card"><div class="cardHeader"><div><div class="title">'
    + escapeHtml(record.veiculo) + " · " + escapeHtml(record.placa)
    + '</div><div class="muted">' + escapeHtml(record.motorista) + '</div></div><span class="'
    + badgeClass + '">' + badge + '</span></div><div class="recordInfo">Saída: '
    + formatDate(record.saida) + " · " + escapeHtml(meterName(record.medidor)) + " inicial: " + escapeHtml(record.valorIni)
    + "<br>Chegada: " + formatDate(record.chegada)
    + (record.valorFim !== "" && record.valorFim != null ? " · " + escapeHtml(meterName(record.medidor)) + " final: " + escapeHtml(record.valorFim) : "")
    + delta + "<br>Origem: " + escapeHtml(record.origem) + " · Destino: " + escapeHtml(record.destino)
    + (record.obs ? "<br>Obs: " + escapeHtml(record.obs) : "")
    + (record.atualizadoPor ? "<br>Última alteração por: " + escapeHtml(record.atualizadoPor) : "")
    + error + "</div>" + signature + actions + "</article>";
}

async function mergeRemoteRecords(remote) {
  const local = await storeGetAll("records");
  const remoteIds = new Set(remote.map(item => String(item.id)));
  for (const item of remote) {
    const prior = local.find(r => (r.id && String(r.id) === String(item.id))
      || (item.clientId && r.clientId && r.clientId === item.clientId));
    if (prior && prior.syncState === "pending") continue;
    const key = "server:" + item.id;
    if (prior && prior.key !== key) await storeDelete("records", prior.key);
    await storePut("records", Object.assign({}, item, {
      key: key,
      localOwned: !!(prior && prior.localOwned),
      localOwnerUser: prior ? prior.localOwnerUser : "",
      syncState: "synced",
      syncUser: "",
      syncError: ""
    }));
  }
  for (const prior of local) {
    if (prior.id && prior.syncState !== "pending" && !remoteIds.has(String(prior.id))) {
      await storeDelete("records", prior.key);
    }
  }
}

async function handleExpiredSession(error) {
  if (!auth || !/sess[aã]o expirada/i.test(error.message || "")) return false;
  const previous = auth;
  setAuth(null);
  $("loginUser").value = previous.usuario;
  showLogin("Sua sessão expirou. Conecte-se e entre novamente; os registros pendentes continuam salvos.");
  return true;
}

async function syncPending() {
  if (!auth || !navigator.onLine || syncBusy) return;
  syncBusy = true;
  try {
    const queue = (await storeGetAll("records"))
      .filter(record => record.syncState === "pending" && record.syncUser === auth.usuario);
    for (const record of queue) {
      if (!auth || !navigator.onLine) break;
      try {
        const result = await postApi("save", { token: auth.token, registro: record });
        const oldKey = record.key;
        record.id = result.id;
        record.key = "server:" + result.id;
        record.syncState = "synced";
        record.syncUser = "";
        record.syncError = "";
        record.atualizadoPor = auth.usuario;
        await storePut("records", record);
        if (oldKey !== record.key) await storeDelete("records", oldKey);
      } catch (error) {
        record.syncError = error.message || "Falha ao sincronizar.";
        await storePut("records", record);
        if (await handleExpiredSession(error)) break;
        setNotice("Um registro continua pendente: " + record.syncError, true);
        break;
      }
    }
  } finally {
    syncBusy = false;
    if (auth) {
      await renderRecords();
      await updateNetworkStatus();
    }
  }
}

async function refreshOnline() {
  if (!auth) return;
  if (!navigator.onLine) {
    setNotice("Sem conexão. Os dados salvos anteriormente continuam disponíveis.");
    await renderRecords();
    return;
  }
  if (refreshBusy) return;
  refreshBusy = true;
  $("refreshBtn").disabled = true;
  try {
    await syncPending();
    if (!auth) return;
    const remote = await postApi("list", { token: auth.token });
    await mergeRemoteRecords(remote);
    const inventory = await postApi("inventory", { token: auth.token });
    await replaceInventory(inventory);
    setNotice("");
  } catch (error) {
    if (!(await handleExpiredSession(error))) {
      setNotice("Não foi possível atualizar agora. Os registros locais foram preservados.", true);
    }
  } finally {
    refreshBusy = false;
    $("refreshBtn").disabled = false;
    if (auth) await renderRecords();
  }
}

function updateMeterLabels() {
  const name = meterName($("meter").value);
  $("initialLabel").textContent = name + " inicial";
  $("finalLabel").textContent = name + " final";
}

async function lookupInventory() {
  const code = $("inventoryCode").value.trim().toUpperCase();
  $("inventoryCode").value = code;
  if (!code) return;
  $("formMsg").textContent = "Consultando inventário…";
  let item = (await storeGetAll("inventory")).find(entry => entry.codigo === code);
  if (!item && navigator.onLine && auth) {
    try {
      item = await postApi("lookup", { token: auth.token, codigo: code });
      if (item) await storePut("inventory", Object.assign({ codigo: code }, item));
    } catch (error) {
      $("formMsg").textContent = error.message || "Não foi possível consultar o inventário.";
      return;
    }
  }
  if (!item) {
    $("formMsg").textContent = navigator.onLine
      ? "Código não encontrado. Você pode preencher os dados manualmente."
      : "Código não está no inventário salvo neste aparelho. Preencha os dados manualmente.";
    return;
  }
  $("vehicle").value = item.veiculo;
  $("plate").value = item.placa;
  $("meter").value = item.medidor;
  updateMeterLabels();
  $("formMsg").textContent = "";
}

function clearCanvas(resetSignature) {
  const canvas = $("signature");
  const context = canvas.getContext("2d");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  if (resetSignature) signatureData = "";
}

function openForm(record) {
  editing = record ? Object.assign({}, record) : null;
  const locked = !!record && !auth.admin;
  ["inventoryCode", "vehicle", "plate", "driver", "departure", "meter", "initialValue", "origin", "destination"]
    .forEach(id => { $(id).disabled = locked; });
  $("formTitle").textContent = record ? (record.chegada ? "Editar registro" : "Registrar chegada") : "Nova saída";
  $("inventoryCode").value = record ? (record.codigoInv || "") : "";
  $("vehicle").value = record ? (record.veiculo || "") : "";
  $("plate").value = record ? (record.placa || "") : "";
  $("driver").value = record ? (record.motorista || "") : auth.nome;
  $("departure").value = record ? (record.saida || "") : dateTimeNow();
  $("meter").value = record ? (record.medidor || "KM") : "KM";
  $("initialValue").value = record && record.valorIni != null ? record.valorIni : "";
  $("origin").value = record ? (record.origem || "") : "";
  $("destination").value = record ? (record.destino || "") : "";
  $("arrival").value = record ? (record.chegada || "") : "";
  $("finalValue").value = record && record.valorFim != null ? record.valorFim : "";
  $("notes").value = record ? (record.obs || "") : "";
  $("formMsg").textContent = "";
  updateMeterLabels();
  signatureData = record ? (record.assinatura || "") : "";
  clearCanvas(false);
  if (signatureData) {
    const image = new Image();
    image.onload = () => $("signature").getContext("2d").drawImage(image, 0, 0);
    image.src = signatureData;
  }
  $("appView").classList.add("hidden");
  $("formView").classList.remove("hidden");
  window.scrollTo(0, 0);
}

function closeForm() {
  editing = null;
  $("formView").classList.add("hidden");
  $("appView").classList.remove("hidden");
}

function validateRecord(record) {
  if (!record.veiculo || !record.placa || !record.motorista || !record.saida
      || record.valorIni === "" || !record.origem || !record.destino) {
    return "Preencha veículo, placa/tag, motorista, saída, leitura inicial, origem e destino.";
  }
  if (!Number.isFinite(Number(record.valorIni))) return "A leitura inicial deve ser numérica.";
  if ((record.chegada && record.valorFim === "") || (!record.chegada && record.valorFim !== "")) {
    return "Informe juntos a chegada e a leitura final.";
  }
  if (record.valorFim !== "" && !Number.isFinite(Number(record.valorFim))) return "A leitura final deve ser numérica.";
  if (record.valorFim !== "" && Number(record.valorFim) < Number(record.valorIni)) {
    return "A leitura final não pode ser menor que a inicial.";
  }
  if (record.chegada && record.chegada < record.saida) return "A chegada não pode ser antes da saída.";
  return "";
}

async function saveRecord() {
  const value = id => $(id).value.trim();
  const existing = editing || {};
  const clientId = existing.clientId || (existing.id ? "" : uuid());
  const record = Object.assign({}, existing, {
    key: existing.key || (existing.id ? "server:" + existing.id : "local:" + clientId),
    id: existing.id || "",
    clientId: clientId,
    codigoInv: value("inventoryCode").toUpperCase(),
    veiculo: value("vehicle"),
    placa: value("plate").toUpperCase(),
    motorista: value("driver"),
    saida: value("departure"),
    medidor: value("meter"),
    valorIni: value("initialValue"),
    origem: value("origin"),
    chegada: value("arrival"),
    valorFim: value("finalValue"),
    destino: value("destination"),
    obs: value("notes"),
    assinatura: signatureData,
    criadoPor: existing.criadoPor || auth.usuario,
    atualizadoPor: auth.usuario,
    localOwned: true,
    localOwnerUser: auth.usuario,
    syncState: "pending",
    syncUser: auth.usuario,
    syncError: ""
  });
  const validation = validateRecord(record);
  if (validation) {
    $("formMsg").textContent = validation;
    return;
  }
  if (record.assinatura && record.assinatura.length > 45000) {
    $("formMsg").textContent = "A assinatura ficou grande demais. Limpe e assine novamente.";
    return;
  }
  $("saveBtn").disabled = true;
  $("formMsg").textContent = "Salvando no aparelho…";
  try {
    await storePut("records", record);
    closeForm();
    setNotice(navigator.onLine ? "Registro salvo. Sincronizando com a planilha…" : "Registro salvo no aparelho; será enviado quando houver conexão.");
    await renderRecords();
    if (navigator.onLine) await refreshOnline();
  } catch (error) {
    $("formMsg").textContent = error.message || "Não foi possível salvar no aparelho.";
  } finally {
    $("saveBtn").disabled = false;
  }
}

async function deleteRecord(key) {
  const record = records.find(item => item.key === key);
  if (!record || !auth.admin || !navigator.onLine) return;
  if (!window.confirm("Excluir este registro? A ação será anotada no histórico.")) return;
  try {
    await postApi("delete", { token: auth.token, id: record.id });
    await storeDelete("records", record.key);
    setNotice("Registro excluído.");
    await refreshOnline();
  } catch (error) {
    if (!(await handleExpiredSession(error))) setNotice(error.message || "Não foi possível excluir.", true);
  }
}

async function login() {
  if (!navigator.onLine) {
    $("loginMsg").textContent = "Para entrar neste aparelho pela primeira vez, conecte-se à internet.";
    return;
  }
  $("loginBtn").disabled = true;
  $("loginMsg").textContent = "Entrando…";
  try {
    const result = await postApi("login", {
      usuario: $("loginUser").value,
      senha: $("loginPass").value
    });
    setAuth(result);
    $("loginPass").value = "";
    $("loginMsg").textContent = "";
    showApp();
    await renderRecords();
    await refreshOnline();
  } catch (error) {
    $("loginMsg").textContent = error.message || "Não foi possível entrar. Verifique a conexão.";
  } finally {
    $("loginBtn").disabled = false;
  }
}

async function logout() {
  const previous = auth;
  setAuth(null);
  if (previous) $("loginUser").value = previous.usuario;
  $("loginPass").value = "";
  showLogin("Sessão encerrada. Os registros pendentes continuam salvos neste aparelho.");
}

async function printRecords() {
  const vehicle = $("vehicleFilter").value;
  const month = $("monthFilter").value;
  if (!vehicle || !month) {
    setNotice("Para imprimir, escolha o veículo e o mês nos filtros.");
    return;
  }

  const selected = records
    .filter(record => (record.veiculo + " · " + record.placa) === vehicle
      && String(record.saida || "").slice(0, 7) === month)
    .sort((a, b) => String(a.saida || "").localeCompare(String(b.saida || "")));
  if (!selected.length) {
    setNotice("Nenhum registro nesse veículo e mês.");
    return;
  }

  const dateOnly = value => value ? value.split("T")[0].split("-").reverse().join("/") : "";
  const rows = selected.map(record => {
    const [departureDate, departureTime] = String(record.saida || "").split("T");
    const [arrivalDate, arrivalTime] = String(record.chegada || "").split("T");
    const meter = record.medidor || "KM";
    const initialValue = record.valorIni == null ? "" : record.valorIni;
    const finalValue = record.valorFim == null ? "" : record.valorFim;
    const signature = /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(record.assinatura || "")
      ? '<img alt="Assinatura" src="' + escapeHtml(record.assinatura) + '">'
      : "";

    return "<tr><td>" + escapeHtml(record.motorista) + "</td><td>" + dateOnly(departureDate)
      + "</td><td>" + escapeHtml(departureTime || "") + "</td><td>" + escapeHtml(meter + " " + initialValue)
      + "</td><td>" + dateOnly(arrivalDate) + "</td><td>" + escapeHtml(arrivalTime || "")
      + "</td><td>" + escapeHtml(meter + " " + finalValue) + "</td><td>" + escapeHtml(record.origem)
      + "</td><td>" + escapeHtml(record.destino) + '</td><td class="signatureCell">' + signature + "</td></tr>";
  }).join("");
  const observations = selected
    .filter(record => record.obs)
    .map(record => dateOnly(record.saida) + ": " + escapeHtml(record.obs))
    .join("<br>");

  $("printReport").innerHTML = '<div class="printHeader"><span>DIÁRIO DE BORDO</span>'
    + "<span>REMF-013 REV.: 00 · DATA DE REV.: 26/08/2022</span></div>"
    + '<div class="printHeader printVehicle"><span>VEÍCULO: ' + escapeHtml(selected[0].veiculo)
    + "</span><span>PLACA/TAG: " + escapeHtml(selected[0].placa) + "</span><span>MÊS: "
    + month.split("-").reverse().join("/") + "</span></div>"
    + "<table><thead><tr><th>MOTORISTA</th><th>DATA SAÍDA</th><th>HORA DE SAÍDA</th>"
    + "<th>LEITURA INICIAL</th><th>DATA DE CHEGADA</th><th>HORA DE CHEGADA</th>"
    + "<th>LEITURA FINAL</th><th>ORIGEM</th><th>DESTINO</th><th>ASSINATURA</th></tr></thead><tbody>"
    + rows + "</tbody></table><div class=\"printObservations\"><b>OBS:</b> " + observations + "</div>";

  const images = Array.from($("printReport").querySelectorAll("img"));
  await Promise.all(images.map(image => image.complete ? Promise.resolve() : new Promise(resolve => {
    image.addEventListener("load", resolve, { once: true });
    image.addEventListener("error", resolve, { once: true });
  })));
  window.print();
}

function startSignature() {
  const canvas = $("signature");
  const context = canvas.getContext("2d");
  context.lineWidth = 2.5;
  context.lineCap = "round";
  context.strokeStyle = "#111";
  const point = event => {
    const rect = canvas.getBoundingClientRect();
    return [(event.clientX - rect.left) * canvas.width / rect.width,
      (event.clientY - rect.top) * canvas.height / rect.height];
  };
  canvas.addEventListener("pointerdown", event => {
    drawing = true;
    canvas.setPointerCapture(event.pointerId);
    const p = point(event);
    context.beginPath();
    context.moveTo(p[0], p[1]);
    context.lineTo(p[0] + 0.1, p[1]);
    context.stroke();
  });
  canvas.addEventListener("pointermove", event => {
    if (!drawing) return;
    const p = point(event);
    context.lineTo(p[0], p[1]);
    context.stroke();
  });
  const end = () => {
    if (!drawing) return;
    drawing = false;
    signatureData = canvas.toDataURL("image/png");
  };
  canvas.addEventListener("pointerup", end);
  canvas.addEventListener("pointercancel", end);
}

async function initialize() {
  await openDatabase();
  $("appVersion").textContent = "VER. " + APP_VERSION;
  startSignature();
  $("loginBtn").addEventListener("click", login);
  $("loginPass").addEventListener("keydown", event => { if (event.key === "Enter") login(); });
  $("newBtn").addEventListener("click", () => openForm(null));
  $("refreshBtn").addEventListener("click", refreshOnline);
  $("logoutBtn").addEventListener("click", logout);
  $("printBtn").addEventListener("click", printRecords);
  $("cancelBtn").addEventListener("click", closeForm);
  $("saveBtn").addEventListener("click", saveRecord);
  $("clearSignature").addEventListener("click", () => clearCanvas(true));
  $("meter").addEventListener("change", updateMeterLabels);
  $("inventoryCode").addEventListener("change", lookupInventory);
  $("vehicleFilter").addEventListener("change", renderRecords);
  $("monthFilter").addEventListener("change", renderRecords);
  $("records").addEventListener("click", event => {
    const button = event.target.closest("button");
    if (!button) return;
    if (button.dataset.edit) {
      const record = records.find(item => item.key === button.dataset.edit);
      if (record) openForm(record);
    } else if (button.dataset.delete) {
      deleteRecord(button.dataset.delete);
    }
  });
  window.addEventListener("online", refreshOnline);
  window.addEventListener("pageshow", () => { if (auth && navigator.onLine) refreshOnline(); });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && auth && navigator.onLine) refreshOnline();
  });
  window.addEventListener("beforeinstallprompt", event => {
    event.preventDefault();
    deferredInstallPrompt = event;
    $("installBtn").classList.remove("hidden");
  });
  $("installBtn").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    $("installBtn").classList.add("hidden");
  });
  window.addEventListener("appinstalled", () => $("installBtn").classList.add("hidden"));
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(error => {
      console.error("Não foi possível registrar o service worker:", error);
    });
  }

  try {
    const saved = localStorage.getItem("diario-bordo-auth");
    if (saved) {
      auth = JSON.parse(saved);
      showApp();
      await renderRecords();
      if (navigator.onLine) await refreshOnline();
      return;
    }
  } catch (error) {
    localStorage.removeItem("diario-bordo-auth");
  }
  showLogin(navigator.onLine ? "" : "Entre uma vez com internet para habilitar o uso offline neste aparelho.");
}

initialize().catch(error => {
  console.error(error);
  showLogin("Não foi possível iniciar o armazenamento offline neste aparelho.");
});
