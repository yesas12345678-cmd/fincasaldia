// ==========================================
// LÓGICA DE ADMINISTRACIÓN COMPLETA - FINCASERRANO
// ==========================================

// --- CONFIGURACIÓN Y ESTADO INICIAL ---
const DEFAULT_FINCAS = [
  { id: 'finca-1', name: 'Finca 1', lat: 37.7796, lng: -3.7849 },
  { id: 'finca-2', name: 'Finca 2', lat: 37.1765, lng: -3.4831 },
  { id: 'finca-3', name: 'Finca 3', lat: 39.4081, lng: -3.2084 }
];

const DEFAULT_INCIDENCIAS = [
  {
    id: 'inc-1',
    fincaId: 'finca-1',
    tipo: 'Goma rota',
    descripcion: 'Goma rota en el sector 4 del ramal principal. Hay una fuga de agua considerable.',
    estado: 'Pendiente',
    lat: 37.7792,
    lng: -3.7842,
    fecha: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'inc-2',
    fincaId: 'finca-2',
    tipo: 'Almendro seco',
    descripcion: 'Almendro de 3 años seco en la hilera 12. Requiere replantar en otoño.',
    estado: 'Pendiente',
    lat: 37.1768,
    lng: -3.4838,
    fecha: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString()
  },
  {
    id: 'inc-3',
    fincaId: 'finca-3',
    tipo: 'Válvula rota',
    descripcion: 'Electroválvula de zona bloqueada. No abre el paso de agua.',
    estado: 'Resuelta',
    lat: 39.4078,
    lng: -3.2078,
    fecha: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString()
  }
];

// Estado global de la administración
let appState = {
  fincas: [],
  incidencias: []
};

// Variables del mapa de dibujo en pestaña Selección
let adminMap = null;
let drawnPoints = [];          // Coordenadas dibujadas: [{lat, lng}, ...]
let drawingMarkers = [];       // Marcadores circulares auxiliares en mapa
let drawingPolyline = null;    // Línea discontinua que sigue el trazado
let finalPolygon = null;       // Objeto polígono cerrado final
let fincaMaskLayer = null;     // Capa de máscara negra exterior
let isDrawingMode = false;     // ¿El modo dibujo está activo?
let centroid = null;           // Lat/lng centro de la finca dibujada
let tempImportedFinca = null;  // Almacén temporal del archivo importado en el modal

// --- CONTROL DE ACCESO (CONTRASEÑA) ---
const ADMIN_PASSWORD = "Manuel1214$";

function checkAuthentication() {
  const isAuth = sessionStorage.getItem('fs_auth') === 'true';
  const loginPanel = document.getElementById('login-panel');
  const dashboard = document.getElementById('admin-dashboard');
  
  if (isAuth) {
    loginPanel.style.display = 'none';
    dashboard.classList.add('authenticated');
    // Inicializar mapas y UI si estamos autenticados
    initAdminApp();
  } else {
    loginPanel.style.display = 'flex';
    dashboard.classList.remove('authenticated');
  }
}

// Escuchador de envío de contraseña
document.getElementById('form-login').addEventListener('submit', (e) => {
  e.preventDefault();
  const passwordInput = document.getElementById('admin-password');
  const errorText = document.getElementById('login-error');
  
  if (passwordInput.value === ADMIN_PASSWORD) {
    sessionStorage.setItem('fs_auth', 'true');
    errorText.style.display = 'none';
    checkAuthentication();
  } else {
    errorText.style.display = 'block';
    passwordInput.value = '';
    passwordInput.focus();
  }
});

// Arrancar comprobando autenticación en carga
document.addEventListener('DOMContentLoaded', () => {
  checkAuthentication();
});

// --- AUXILIARES DE SINCRONIZACIÓN EN LA NUBE ---
function getCloudSyncUrl(code = '', action = '') {
  return `../.netlify/functions/sync?${action ? 'action=' + action + '&' : ''}${code ? 'code=' + code : ''}`;
}

let accountsList = [];
let selectedAccount = '';

function loadAccountsList() {
  const select = document.getElementById('admin-account-select');
  select.innerHTML = '<option value="">Cargando cuentas...</option>';
  
  fetch(getCloudSyncUrl('', 'list') + '&password=Manuel1214$')
  .then(res => {
    if (!res.ok) throw new Error("Error cargando cuentas");
    return res.json();
  })
  .then(data => {
    accountsList = data;
    select.innerHTML = '<option value="">-- Selecciona una cuenta --</option>';
    data.forEach(acc => {
      const opt = document.createElement('option');
      opt.value = acc.code;
      opt.textContent = `${acc.code} (Última mod: ${new Date(Number(acc.last_updated)).toLocaleString()})`;
      if (acc.code === selectedAccount) {
        opt.selected = true;
      }
      select.appendChild(opt);
    });
  })
  .catch(err => {
    console.error(err);
    select.innerHTML = '<option value="">Error al cargar cuentas</option>';
  });
}

function selectAccount(code) {
  if (!code) {
    selectedAccount = '';
    sessionStorage.removeItem('fs_selected_account');
    document.getElementById('active-account-indicator').style.display = 'none';
    appState = { fincas: [], incidencias: [], folders: [], lastUpdated: 0 };
    renderFincasSettingsList();
    renderFoldersSettingsList();
    disableAdminControls(true);
    return;
  }
  
  selectedAccount = code;
  sessionStorage.setItem('fs_selected_account', code);
  
  document.getElementById('active-account-indicator').style.display = 'block';
  document.getElementById('text-editing-account').textContent = code;
  
  fetch(getCloudSyncUrl(code))
  .then(res => {
    if (!res.ok) throw new Error("No se pudo cargar la cuenta");
    return res.json();
  })
  .then(cloudData => {
    appState = cloudData;
    appState.syncCode = code;
    
    if (!appState.folders || appState.folders.length === 0) {
      appState.folders = [
        { id: 'folder-huescar', name: 'Huéscar' },
        { id: 'folder-baza', name: 'Baza' }
      ];
    }
    
    disableAdminControls(false);
    renderFincasSettingsList();
    renderFoldersSettingsList();
    populateFolderSelects();
    
    if (appState.fincas && appState.fincas.length > 0 && adminMap) {
      const first = appState.fincas[0];
      adminMap.setView([first.lat, first.lng], 15);
    }
  })
  .catch(err => {
    console.error(err);
    alert("Error al cargar los datos de la cuenta.");
  });
}

function disableAdminControls(disabled) {
  const btns = [
    'btn-settings-add-finca',
    'btn-create-folder',
    'btn-export-backup',
    'input-import-backup',
    'btn-reset-db',
    'btn-draw-pencil',
    'btn-draw-clear',
    'input-new-folder',
    'input-admin-search',
    'btn-admin-search-submit'
  ];
  
  btns.forEach(id => {
    const el = document.getElementById(id);
    if (el) {
      el.disabled = disabled;
    }
  });
}

function createNewAccount() {
  const input = document.getElementById('input-new-account-code');
  const code = input.value.trim().toLowerCase();
  if (!code) {
    alert("Introduce un código de cuenta válido.");
    return;
  }
  
  if (!/^[a-z0-9_-]+$/.test(code)) {
    alert("El código de la cuenta solo puede contener letras, números, guiones y barras bajas.");
    return;
  }
  
  fetch(getCloudSyncUrl(code))
  .then(res => {
    if (res.status === 200) {
      alert("Esta cuenta ya existe. Elige otro nombre.");
      return;
    }
    
    const initialState = {
      fincas: [],
      incidencias: [],
      folders: [
        { id: 'folder-huescar', name: 'Huéscar' },
        { id: 'folder-baza', name: 'Baza' }
      ],
      shoppingList: [],
      checkedIncidentSupplies: [],
      syncCode: code,
      lastUpdated: Date.now()
    };
    
    return fetch(getCloudSyncUrl(code), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(initialState)
    })
    .then(createRes => {
      if (!createRes.ok) throw new Error("Error al crear cuenta");
      alert(`¡Cuenta "${code}" creada con éxito!`);
      input.value = '';
      loadAccountsList();
      selectAccount(code);
    });
  })
  .catch(err => {
    console.error(err);
    alert("Error al conectar con la base de datos.");
  });
}

// --- INICIALIZACIÓN DE LA APLICACIÓN DE ADMINISTRACIÓN ---
function initAdminApp() {
  setupEventListeners();
  loadAccountsList();
  
  const lastAccount = sessionStorage.getItem('fs_selected_account');
  if (lastAccount) {
    selectedAccount = lastAccount;
    selectAccount(lastAccount);
  } else {
    disableAdminControls(true);
  }
  
  setTimeout(() => {
    initAdminMap();
  }, 100);
}

// Guardar datos en la base de datos PostgreSQL de la nube
function saveData() {
  if (!selectedAccount) return;
  appState.lastUpdated = Date.now();
  
  fetch(getCloudSyncUrl(selectedAccount), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(appState)
  })
  .then(res => {
    if (!res.ok) throw new Error("Error al guardar en la nube");
    console.log("Cambios guardados en PostgreSQL con éxito.");
  })
  .catch(err => {
    console.error(err);
    alert("Atención: No se han podido guardar los cambios en la base de datos de la nube. Comprueba tu conexión.");
  });
}

// --- RENDERIZADO DEL LISTADO DE CONFIGURACIÓN ---
function renderFincasSettingsList() {
  const container = document.getElementById('fincas-settings-list');
  container.innerHTML = '';
  
  appState.fincas.forEach(finca => {
    const item = document.createElement('div');
    item.className = 'finca-settings-item';
    
    // Contar incidencias asociadas
    const count = appState.incidencias.filter(i => i.fincaId === finca.id).length;
    const hasBoundary = finca.polygon && finca.polygon.length > 0;
    const boundaryTag = hasBoundary ? 'Linde dibujada' : 'Solo coordenadas';
    const boundaryStyle = hasBoundary ? 'color: var(--primary); font-weight:600;' : 'color: var(--text-muted);';
    
    item.innerHTML = `
      <div class="finca-info-group">
        <span class="finca-info-name">${finca.name}</span>
        <span class="finca-info-meta">
          Coords: ${finca.lat.toFixed(4)}, ${finca.lng.toFixed(4)} | 
          <span style="${boundaryStyle}">${boundaryTag}</span> | 
          ${count} incidencias
        </span>
      </div>
      <button class="btn-delete-finca" onclick="deleteFincaAction('${finca.id}')" title="Eliminar finca">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-sm"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    `;
    
    container.appendChild(item);
  });
}

// --- RENDERIZADO DE CARPETAS ---
function renderFoldersSettingsList() {
  const container = document.getElementById('folders-settings-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (!appState.folders) appState.folders = [];
  
  appState.folders.forEach(folder => {
    const item = document.createElement('div');
    item.className = 'finca-settings-item';
    item.style.padding = '8px 12px';
    
    const count = (appState.fincas || []).filter(f => f.folderId === folder.id).length;
    
    item.innerHTML = `
      <div class="finca-info-group">
        <span class="finca-info-name" style="font-weight: 500;">📂 ${folder.name}</span>
        <span class="finca-info-meta">${count} fincas</span>
      </div>
      ${folder.id !== 'general' ? `
        <button class="btn-delete-finca" onclick="deleteFolderAction('${folder.id}')" title="Eliminar carpeta" style="background: none; border: none; color: var(--danger); cursor: pointer;">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-sm" style="width: 16px; height: 16px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      ` : ''}
    `;
    container.appendChild(item);
  });
}

function createFolderAction() {
  const input = document.getElementById('input-new-folder');
  const name = input.value.trim();
  if (!name) return;
  
  if (!appState.folders) appState.folders = [];
  
  const newFolder = {
    id: 'folder-' + Date.now(),
    name: name
  };
  
  appState.folders.push(newFolder);
  saveData();
  input.value = '';
  renderFoldersSettingsList();
  populateFolderSelects();
}

function deleteFolderAction(id) {
  if (id === 'general') return;
  if (confirm("¿Estás seguro de que quieres eliminar esta carpeta? Las fincas que estén dentro se moverán a la carpeta General.")) {
    (appState.fincas || []).forEach(f => {
      if (f.folderId === id) f.folderId = 'general';
    });
    appState.folders = appState.folders.filter(f => f.id !== id);
    saveData();
    renderFoldersSettingsList();
    renderFincasSettingsList();
    populateFolderSelects();
  }
}

function populateFolderSelects() {
  const select = document.getElementById('drawn-finca-folder-select');
  if (!select) return;
  select.innerHTML = '';
  
  if (!appState.folders) appState.folders = [];
  
  appState.folders.forEach(folder => {
    const opt = document.createElement('option');
    opt.value = folder.id;
    opt.textContent = folder.name;
    select.appendChild(opt);
  });
}

// Exponer funciones globales
window.deleteFolderAction = deleteFolderAction;

// --- EVENT LISTENERS GENERALES ---
function setupEventListeners() {
  // Cambio de cuenta seleccionada
  document.getElementById('admin-account-select').addEventListener('change', (e) => {
    selectAccount(e.target.value);
  });

  // Botón recargar lista de cuentas
  document.getElementById('btn-reload-accounts').addEventListener('click', loadAccountsList);

  // Botón crear nueva cuenta
  document.getElementById('btn-create-account').addEventListener('click', createNewAccount);

  // Botón crear carpeta
  document.getElementById('btn-create-folder').addEventListener('click', createFolderAction);
  document.getElementById('input-new-folder').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') createFolderAction();
  });

  // Navegación de Pestañas (Tabs)
  const tabButtons = document.querySelectorAll('.admin-tab-btn');
  const tabContents = document.querySelectorAll('.admin-tab-content');
  
  tabButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      
      tabButtons.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      btn.classList.add('active');
      document.getElementById(targetId).classList.add('active');
      
      if (targetId === 'tab-seleccion' && adminMap) {
        setTimeout(() => {
          adminMap.invalidateSize();
        }, 150);
      }
    });
  });

  // Copias de seguridad generales
  document.getElementById('btn-export-backup').addEventListener('click', exportBackup);
  document.getElementById('input-import-backup').addEventListener('change', importBackup);
  document.getElementById('btn-reset-db').addEventListener('click', resetDatabase);

  // --- MODAL NUEVA FINCA / IMPORTAR ---
  const modalFinca = document.getElementById('modal-finca');
  const btnAddFinca = document.getElementById('btn-settings-add-finca');
  const btnCloseFinca1 = document.getElementById('btn-close-modal-finca');
  const btnCloseFinca2 = document.getElementById('btn-cancel-finca');
  const modalOverlay = document.getElementById('modal-finca-overlay');

  const openFincaModal = () => {
    document.getElementById('form-finca').reset();
    document.getElementById('modal-finca-file-info').textContent = "Ningún archivo seleccionado.";
    document.getElementById('modal-finca-file-info').style.color = "var(--text-muted)";
    tempImportedFinca = null;
    modalFinca.classList.add('active');
  };

  const closeModalFinca = () => {
    modalFinca.classList.remove('active');
  };

  btnAddFinca.addEventListener('click', openFincaModal);
  btnCloseFinca1.addEventListener('click', closeModalFinca);
  btnCloseFinca2.addEventListener('click', closeModalFinca);
  modalOverlay.addEventListener('click', closeModalFinca);

  document.getElementById('modal-finca-file').addEventListener('change', handleModalFileImport);
  document.getElementById('form-finca').addEventListener('submit', handleModalFincaSubmit);

  // --- CONTROLES DE DIBUJO ---
  document.getElementById('btn-draw-pencil').addEventListener('click', toggleDrawingMode);
  document.getElementById('btn-draw-clear').addEventListener('click', clearDrawing);
  document.getElementById('btn-save-drawn').addEventListener('click', saveDrawnFinca);
  document.getElementById('btn-export-drawn').addEventListener('click', exportDrawnFinca);

  // --- BUSCADOR GEOGRÁFICO ---
  document.getElementById('btn-admin-search-submit').addEventListener('click', executeLocationSearch);
  document.getElementById('input-admin-search').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      executeLocationSearch();
    }
  });
}

// --- CONFIGURACIÓN DEL MAPA DE ADMINISTRACIÓN ---
function initAdminMap() {
  if (adminMap) return; // Evitar duplicar
  
  // Centrar en Jaén/Andalucía de forma predeterminada
  adminMap = L.map('admin-map', {
    center: [37.7796, -3.7849],
    zoom: 15,
    zoomControl: true,
    attributionControl: false // Desactivar copyright para máxima limpieza
  });
  
  // Capa satélite ArcGIS
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19
  }).addTo(adminMap);
  
  // Evento de clic en el mapa para dibujar
  adminMap.on('click', handleMapClickForDrawing);
  
  // Evento de doble clic para cerrar polígono
  adminMap.on('dblclick', handleMapDblClickForDrawing);
}

// --- BUSCADOR DE UBICACIÓN (NOMINATIM / COORDENADAS) ---
async function executeLocationSearch() {
  const query = document.getElementById('input-admin-search').value.trim();
  const resultsContainer = document.getElementById('search-results-list');
  resultsContainer.innerHTML = '';
  resultsContainer.style.display = 'none';
  
  if (!query) return;

  // Caso A: El usuario ha pegado coordenadas directas (ej: "37.7792, -3.7842")
  const coordRegex = /^[-+]?([1-9]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/;
  if (coordRegex.test(query)) {
    const parts = query.split(',');
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    
    if (adminMap) {
      adminMap.setView([lat, lng], 17);
      // Añadir un marcador temporal de referencia
      const tempMarker = L.marker([lat, lng]).addTo(adminMap);
      setTimeout(() => adminMap.removeLayer(tempMarker), 4000);
    }
    return;
  }

  // Caso B: Buscar ciudad, calle o finca en la API Nominatim
  const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`;
  
  try {
    const response = await fetch(url, {
      headers: { 'Accept-Language': 'es' }
    });
    const results = await response.json();
    
    if (results && results.length > 0) {
      resultsContainer.style.display = 'block';
      results.forEach(item => {
        const div = document.createElement('div');
        div.className = 'search-results-item';
        div.textContent = item.display_name;
        div.addEventListener('click', () => {
          const lat = parseFloat(item.lat);
          const lon = parseFloat(item.lon);
          adminMap.setView([lat, lon], 16);
          resultsContainer.style.display = 'none';
          document.getElementById('input-admin-search').value = item.display_name;
        });
        resultsContainer.appendChild(div);
      });
    } else {
      alert("No se encontraron resultados para esa búsqueda.");
    }
  } catch (err) {
    console.error("Error en la geolocalización:", err);
    alert("Hubo un error al conectar con el servidor de búsqueda. Inténtalo de nuevo.");
  }
}

// Cierra el dropdown de búsqueda si se hace clic fuera
document.addEventListener('click', (e) => {
  const container = document.getElementById('search-results-list');
  const input = document.getElementById('input-admin-search');
  if (e.target !== container && e.target !== input) {
    container.style.display = 'none';
  }
});

// --- MOTOR DE DIBUJO DE POLÍGONOS ---

function toggleDrawingMode() {
  const btn = document.getElementById('btn-draw-pencil');
  const statusText = document.getElementById('draw-status-text');
  
  if (!isDrawingMode) {
    // Activar modo
    isDrawingMode = true;
    btn.classList.add('active');
    statusText.textContent = "Lápiz activo. Toca el mapa para añadir esquinas de tu linde. Doble clic para cerrar el área.";
    
    // Desactivar doble click zoom de Leaflet mientras se dibuja para evitar saltos de cámara
    if (adminMap) {
      adminMap.doubleClickZoom.disable();
    }
    
    // Limpiar si ya había algo
    clearDrawing();
  } else {
    // Desactivar modo
    stopDrawingMode();
  }
}

function stopDrawingMode() {
  isDrawingMode = false;
  document.getElementById('btn-draw-pencil').classList.remove('active');
  document.getElementById('draw-status-text').textContent = "Herramienta inactiva. Toca el lápiz para empezar.";
  
  if (adminMap) {
    adminMap.doubleClickZoom.enable();
  }
}

function handleMapClickForDrawing(e) {
  if (!isDrawingMode) return;
  
  const { lat, lng } = e.latlng;
  
  // Si ya tenemos 3 o más puntos, ver si hacemos click cerca del primero para cerrar la linde
  if (drawnPoints.length >= 3) {
    const firstPoint = L.latLng(drawnPoints[0][0], drawnPoints[0][1]);
    const dist = adminMap.distance(e.latlng, firstPoint);
    if (dist < 15) { // Tolerancia de 15 metros en el click del mapa
      finishDrawing();
      return;
    }
  }
  
  drawnPoints.push([lat, lng]);
  
  // Dibujar marcador de nodo/esquina de la linde (un poco más grueso para facilitar el click encima)
  const marker = L.circleMarker([lat, lng], {
    radius: 6,
    color: '#FF6B6B',
    fillColor: '#FFFFFF',
    fillOpacity: 1,
    weight: 2.5
  }).addTo(adminMap);
  
  // Si es el primer punto, añadir listener para que al clickar encima se cierre la linde
  if (drawnPoints.length === 1) {
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (drawnPoints.length >= 3) {
        finishDrawing();
      }
    });
  }
  
  drawingMarkers.push(marker);
  
  // Dibujar o actualizar línea temporal
  if (drawingPolyline) {
    adminMap.removeLayer(drawingPolyline);
  }
  
  drawingPolyline = L.polyline(drawnPoints, {
    color: '#FF6B6B',
    dashArray: '5, 5',
    weight: 3
  }).addTo(adminMap);
  
  // Habilitar botón borrar/limpiar
  document.getElementById('btn-draw-clear').removeAttribute('disabled');
}

function handleMapDblClickForDrawing(e) {
  if (!isDrawingMode) return;
  
  // Leaflet dblclick puede añadir un punto adicional, lo quitamos si es muy cercano para evitar duplicados
  if (drawnPoints.length >= 3) {
    // Cerrar el polígono
    finishDrawing();
  } else {
    alert("Dibuja al menos 3 esquinas sobre el mapa antes de cerrar el polígono.");
  }
}

function finishDrawing() {
  if (drawnPoints.length < 3) return;
  
  stopDrawingMode();
  
  // Limpiar capas temporales de dibujo
  drawingMarkers.forEach(m => adminMap.removeLayer(m));
  drawingMarkers = [];
  if (drawingPolyline) {
    adminMap.removeLayer(drawingPolyline);
    drawingPolyline = null;
  }
  
  // 1. Dibujar el polígono de linde
  finalPolygon = L.polygon(drawnPoints, {
    color: '#3B7A57',
    fillColor: '#3B7A57',
    fillOpacity: 0.15,
    weight: 3
  }).addTo(adminMap);
  
  // 2. Calcular Centroide
  let sumLat = 0;
  let sumLng = 0;
  drawnPoints.forEach(pt => {
    sumLat += pt[0];
    sumLng += pt[1];
  });
  centroid = {
    lat: sumLat / drawnPoints.length,
    lng: sumLng / drawnPoints.length
  };
  
  // 3. Dibujar Máscara Negra Invertida fuera de la Finca
  const worldCoords = [
    [-90, -180],
    [-90, 180],
    [90, 180],
    [90, -180]
  ];
  
  fincaMaskLayer = L.polygon([worldCoords, drawnPoints], {
    color: '#000000',
    fillColor: '#000000',
    fillOpacity: 0.9, // Hace que todo fuera del polígono sea negro
    stroke: false,
    interactive: false
  }).addTo(adminMap);
  
  // Enfocar límites en el mapa
  adminMap.fitBounds(finalPolygon.getBounds());
  
  // Mostrar formulario de guardado
  document.getElementById('draw-status-text').textContent = "Área de finca delimitada con éxito.";
  document.getElementById('save-drawn-finca-panel').style.display = 'flex';
  document.getElementById('drawn-finca-coords-text').textContent = `Latitud: ${centroid.lat.toFixed(6)}, Longitud: ${centroid.lng.toFixed(6)}`;
}

function clearDrawing() {
  // Limpiar temporales
  drawingMarkers.forEach(m => adminMap.removeLayer(m));
  drawingMarkers = [];
  
  if (drawingPolyline) {
    adminMap.removeLayer(drawingPolyline);
    drawingPolyline = null;
  }
  
  // Limpiar definitivos
  if (finalPolygon) {
    adminMap.removeLayer(finalPolygon);
    finalPolygon = null;
  }
  
  if (fincaMaskLayer) {
    adminMap.removeLayer(fincaMaskLayer);
    fincaMaskLayer = null;
  }
  
  drawnPoints = [];
  centroid = null;
  
  // Desactivar controles
  document.getElementById('btn-draw-clear').setAttribute('disabled', 'true');
  document.getElementById('save-drawn-finca-panel').style.display = 'none';
  document.getElementById('drawn-finca-name').value = '';
}

// Guardar finca dibujada
function saveDrawnFinca() {
  const name = document.getElementById('drawn-finca-name').value.trim();
  if (!name) {
    alert("Por favor, introduce un nombre para el terreno.");
    return;
  }
  
  const folderId = document.getElementById('drawn-finca-folder-select').value || 'general';
  
  const newFinca = {
    id: 'finca-' + Date.now(),
    name: name,
    lat: centroid.lat,
    lng: centroid.lng,
    polygon: [...drawnPoints],
    folderId: folderId
  };
  
  appState.fincas.push(newFinca);
  saveData();
  
  alert(`Finca "${name}" creada y guardada con éxito en el listado.`);
  
  // Resetear dibujo
  clearDrawing();
  
  // Recargar listas de UI
  renderFincasSettingsList();
  
  // Volver a la pestaña principal de configuración
  document.getElementById('tab-btn-config').click();
}

// Exportar finca dibujada a un archivo JSON individual
function exportDrawnFinca() {
  const name = document.getElementById('drawn-finca-name').value.trim() || 'Nueva_Finca';
  
  const fincaExport = {
    name: name,
    lat: centroid.lat,
    lng: centroid.lng,
    polygon: [...drawnPoints]
  };
  
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(fincaExport, null, 2));
  const downloadAnchor = document.createElement('a');
  
  const safeFileName = name.toLowerCase().replace(/[^a-z0-9]/gi, '_');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `finca_${safeFileName}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// --- CONTROLADORES CRUD DE LA CONFIGURACIÓN ---

// Eliminar Finca del listado
window.deleteFincaAction = function(fincaId) {
  const finca = appState.fincas.find(f => f.id === fincaId);
  if (!finca) return;
  
  // Permite eliminar la última finca si es necesario
  
  const asociadas = appState.incidencias.filter(i => i.fincaId === fincaId);
  
  let confirmMsg = `¿Estás seguro de que quieres eliminar la finca "${finca.name}"?`;
  if (asociadas.length > 0) {
    confirmMsg += `\n\nEsta finca contiene ${asociadas.length} incidencias registradas. Si aceptas, también se eliminarán de forma definitiva todas sus incidencias asociadas.`;
  }
  
  if (confirm(confirmMsg)) {
    // Borrar incidencias asociadas
    appState.incidencias = appState.incidencias.filter(i => i.fincaId !== fincaId);
    // Borrar finca
    appState.fincas = appState.fincas.filter(f => f.id !== fincaId);
    
    // Si era la finca seleccionada activa, deseleccionar o reasignar
    if (appState.selectedFincaId === fincaId) {
      appState.selectedFincaId = appState.fincas.length > 0 ? appState.fincas[0].id : '';
    }
    
    saveData();
    renderFincasSettingsList();
    renderFoldersSettingsList();
  }
};

// Manejar importación de archivo desde el modal
function handleModalFileImport(e) {
  const file = e.target.files[0];
  const fileInfo = document.getElementById('modal-finca-file-info');
  
  if (!file) {
    fileInfo.textContent = "Ningún archivo seleccionado.";
    fileInfo.style.color = "var(--text-muted)";
    tempImportedFinca = null;
    return;
  }
  
  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const importedFinca = JSON.parse(evt.target.result);
      
      // Validación básica
      if (importedFinca.name && typeof importedFinca.lat === 'number' && typeof importedFinca.lng === 'number') {
        tempImportedFinca = {
          name: importedFinca.name,
          lat: importedFinca.lat,
          lng: importedFinca.lng,
          polygon: Array.isArray(importedFinca.polygon) ? importedFinca.polygon : []
        };
        

        
        fileInfo.textContent = `Archivo cargado: ${file.name} (Centro: ${importedFinca.lat.toFixed(4)}, ${importedFinca.lng.toFixed(4)})`;
        fileInfo.style.color = "var(--primary)";
      } else {
        fileInfo.textContent = "Error: El archivo JSON no tiene un formato de finca válido.";
        fileInfo.style.color = "var(--danger)";
        tempImportedFinca = null;
      }
    } catch (err) {
      fileInfo.textContent = "Error al leer el archivo JSON.";
      fileInfo.style.color = "var(--danger)";
      tempImportedFinca = null;
      console.error(err);
    }
  };
  reader.readAsText(file);
}

// Guardar finca desde el formulario del modal
function handleModalFincaSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('finca-name').value.trim();
  
  if (!tempImportedFinca) {
    alert("Por favor, selecciona primero un archivo de finca (.json) válido para importar.");
    return;
  }
  
  if (!name) {
    alert("Por favor, introduce un nombre para la finca.");
    return;
  }
  
  // Guardar la finca con el nombre del input (por si el usuario lo modificó)
  const newFinca = {
    id: 'finca-' + Date.now(),
    name: name,
    lat: tempImportedFinca.lat,
    lng: tempImportedFinca.lng,
    polygon: tempImportedFinca.polygon,
    folderId: 'general'
  };
  
  appState.fincas.push(newFinca);
  saveData();
  renderFincasSettingsList();
  
  document.getElementById('modal-finca').classList.remove('active');
  tempImportedFinca = null;
  
  alert(`Finca "${name}" creada con éxito.`);
}

// Exportar copia de seguridad de la base de datos completa
function exportBackup() {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(appState, null, 2));
  const downloadAnchor = document.createElement('a');
  
  const date = new Date().toISOString().split('T')[0];
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", `fincasserrano_backup_${date}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// Importar copia de seguridad de la base de datos completa
function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const importedData = JSON.parse(evt.target.result);
      
      if (importedData.fincas && Array.isArray(importedData.fincas) && 
          importedData.incidencias && Array.isArray(importedData.incidencias)) {
        
        if (confirm(`Se han detectado ${importedData.fincas.length} fincas y ${importedData.incidencias.length} incidencias en la copia. ¿Deseas reemplazar todos tus datos actuales con este backup?`)) {
          appState = importedData;
          saveData();
          renderFincasSettingsList();
          alert("Base de datos importada con éxito.");
        }
      } else {
        alert("El formato del archivo JSON de copia no es compatible.");
      }
    } catch (err) {
      alert("Error al procesar el archivo. Revisa que sea un JSON válido.");
      console.error(err);
    }
    e.target.value = '';
  };
  reader.readAsText(file);
}

// Restablecer aplicación completa
function resetDatabase() {
  if (confirm("¿Estás seguro de restablecer esta cuenta? Se eliminarán todas las fincas, lindes e incidencias y se restaurarán las carpetas predeterminadas (Huéscar y Baza).")) {
    appState = {
      fincas: [],
      incidencias: [],
      folders: [
        { id: 'folder-huescar', name: 'Huéscar' },
        { id: 'folder-baza', name: 'Baza' }
      ],
      shoppingList: [],
      checkedIncidentSupplies: [],
      syncCode: selectedAccount,
      lastUpdated: Date.now()
    };
    saveData();
    renderFincasSettingsList();
    renderFoldersSettingsList();
    populateFolderSelects();
    alert("Cuenta restablecida con éxito.");
  }
}
