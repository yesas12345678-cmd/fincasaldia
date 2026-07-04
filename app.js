// ==========================================
// APLICACIÓN GESTIÓN AGRÍCOLA - FINCASERRANO
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
    fecha: new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString() // Ayer
  },
  {
    id: 'inc-2',
    fincaId: 'finca-2',
    tipo: 'Almendro seco',
    descripcion: 'Almendro de 3 años seco en la hilera 12. Requiere replantar en otoño.',
    estado: 'Pendiente',
    lat: 37.1768,
    lng: -3.4838,
    fecha: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString() // Hace 3 días
  },
  {
    id: 'inc-3',
    fincaId: 'finca-3',
    tipo: 'Válvula rota',
    descripcion: 'Electroválvula de zona bloqueada. No abre el paso de agua.',
    estado: 'Pendiente',
    lat: 39.4078,
    lng: -3.2078,
    fecha: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString() // Hace 5 días
  }
];

// Variables del flujo de deshacer incidencias y compras
let lastDeletedIncidencia = null;
let lastDeletedShoppingItem = null;
let lastDeletedIncidentSupplyKey = null;
let undoTimeout = null;

// Estado global de la aplicación
let appState = {
  fincas: [],
  incidencias: [],
  selectedFincaId: ''
};

// Variables del mapa Leaflet
let map = null;
let incidentMarkersGroup = null;
let currentMapLayer = 'satellite'; // 'satellite' o 'streets'
let mapLayers = {};
let gpsUserMarker = null;
let gpsUserCircle = null;
let lastGpsPosition = null;
let fincaMaskLayer = null;

// Variables de dibujo y administración (consolidadas en la misma página)
let adminMap = null;
let drawnPoints = [];
let drawingMarkers = [];
let drawingPolyline = null;
let finalPolygon = null;
let adminFincaMaskLayer = null;
let isDrawingMode = false;
let centroid = null;
let tempImportedFinca = null;

// --- INICIALIZACIÓN ---
document.addEventListener('DOMContentLoaded', () => {
  initData();
  setupNavigation();
  initMap();
  setupEventListeners();
  setupAdminEventListeners(); // Inicializar escuchadores del admin
  renderApp();
  startGpsTracking();
  
  // Registrar Service Worker (para soporte Offline de PWA)
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js')
      .then(reg => console.log('Service Worker registrado con éxito:', reg.scope))
      .catch(err => console.error('Error al registrar Service Worker:', err));
  }
  
  // Sincronizar desde la nube al cargar la app
  if (appState.syncCode) {
    fetch(getCloudSyncUrl(appState.syncCode))
    .then(res => {
      if (!res.ok) throw new Error("Sync load failed");
      return res.json();
    })
    .then(cloudData => {
      if (cloudData && cloudData.fincas) {
        const code = appState.syncCode;
        const localTime = appState.lastUpdated || 0;
        const cloudTime = cloudData.lastUpdated || 0;
        
        if (cloudTime > localTime) {
          appState = cloudData;
          appState.syncCode = code;
          sanitizeData();
          
          // Guardar localmente
          localStorage.setItem('fh_fincas', JSON.stringify(appState.fincas));
          localStorage.setItem('fh_incidencias', JSON.stringify(appState.incidencias));
          localStorage.setItem('fh_folders', JSON.stringify(appState.folders));
          localStorage.setItem('fh_shopping_list', JSON.stringify(appState.shoppingList || []));
          localStorage.setItem('fh_checked_supplies', JSON.stringify(appState.checkedIncidentSupplies || []));
          localStorage.setItem('fh_sync_code', appState.syncCode);
          localStorage.setItem('fh_last_updated', String(appState.lastUpdated || 0));
          
          renderApp();
          
          // Centrar el mapa en la finca activa tras sincronizar
          const initialFinca = getFincaById(appState.selectedFincaId);
          if (initialFinca && map) {
            map.setView([initialFinca.lat, initialFinca.lng], 16);
            restrictMapBounds(initialFinca);
          }
          console.log("Datos iniciales sobrescritos con versión más nueva de la nube (LWW).");
        } else if (localTime > cloudTime) {
          // El local es más nuevo: subir a la nube
          saveData(false); // Sube sin refrescar timestamp
          console.log("Datos iniciales de la nube actualizados con versión local más nueva (LWW).");
        }
      }
    })
    .catch(err => console.error("Startup sync error:", err));
  }

  // Comprobar si arranca en modo asistente automático (?voice=true)
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('voice') === 'true') {
    showGiantStartTarget();
  }

  // Bucle de sincronización automática en segundo plano cada 15 segundos
  setInterval(() => {
    if (voiceAssistantActive) return; // Evitar interferencias si están hablando
    if (appState.syncCode) {
      backgroundCloudSync();
    }
  }, 15000);
});

// Inicialización de datos con localStorage
function initData() {
  const savedFincas = localStorage.getItem('fh_fincas');
  const savedIncidencias = localStorage.getItem('fh_incidencias');
  const savedFolders = localStorage.getItem('fh_folders');
  
  if (savedFolders) {
    appState.folders = JSON.parse(savedFolders);
  } else {
    appState.folders = [{ id: 'general', name: 'General' }];
    localStorage.setItem('fh_folders', JSON.stringify(appState.folders));
  }
  
  if (savedFincas) {
    appState.fincas = JSON.parse(savedFincas);
    let modificado = false;
    appState.fincas.forEach(f => {
      if (f.id === 'finca-1' && f.name.includes('Finca 1')) { f.name = 'Finca 1'; modificado = true; }
      if (f.id === 'finca-2' && f.name.includes('Finca 2')) { f.name = 'Finca 2'; modificado = true; }
      if (f.id === 'finca-3' && f.name.includes('Finca 3')) { f.name = 'Finca 3'; modificado = true; }
      if (!f.folderId) { f.folderId = 'general'; modificado = true; }
    });
    if (modificado) {
      localStorage.setItem('fh_fincas', JSON.stringify(appState.fincas));
    }
  } else {
    appState.fincas = [...DEFAULT_FINCAS];
    appState.fincas.forEach(f => f.folderId = 'general');
    localStorage.setItem('fh_fincas', JSON.stringify(appState.fincas));
  }
  
  if (savedIncidencias) {
    appState.incidencias = JSON.parse(savedIncidencias);
  } else {
    appState.incidencias = [...DEFAULT_INCIDENCIAS];
    localStorage.setItem('fh_incidencias', JSON.stringify(appState.incidencias));
  }

  // Carga de lista de la compra, suministros marcados y código de sincronización
  const savedShoppingList = localStorage.getItem('fh_shopping_list');
  const savedCheckedSupplies = localStorage.getItem('fh_checked_supplies');
  const savedSyncCode = localStorage.getItem('fh_sync_code');
  
  if (savedShoppingList) {
    appState.shoppingList = JSON.parse(savedShoppingList);
  } else {
    appState.shoppingList = [];
  }
  
  if (savedCheckedSupplies) {
    appState.checkedIncidentSupplies = JSON.parse(savedCheckedSupplies);
  } else {
    appState.checkedIncidentSupplies = [];
  }
  
  if (savedSyncCode && savedSyncCode !== 'eedaecf') {
    appState.syncCode = savedSyncCode;
  } else {
    appState.syncCode = 'daedcfc'; // Grupo de sincronización por defecto para FincasSerrano
    localStorage.setItem('fh_sync_code', 'daedcfc');
  }
  
  const savedLastUpdated = localStorage.getItem('fh_last_updated');
  if (savedLastUpdated) {
    appState.lastUpdated = parseInt(savedLastUpdated);
  } else {
    appState.lastUpdated = 0;
  }
  
  sanitizeData();
}

// Limpiar y validar datos locales para asegurar que no contengan elementos de prueba (Finca 1, 2, 3) ni carpetas del sistema antiguas
function sanitizeData() {
  if (!appState.fincas) appState.fincas = [];
  if (!appState.incidencias) appState.incidencias = [];
  
  // 1. Eliminar Finca 1, 2 y 3
  appState.fincas = appState.fincas.filter(f => f.id !== 'finca-1' && f.id !== 'finca-2' && f.id !== 'finca-3');
  appState.incidencias = appState.incidencias.filter(i => i.fincaId !== 'finca-1' && i.fincaId !== 'finca-2' && i.fincaId !== 'finca-3');
  
  // 2. Eliminar carpeta general si existe Baza y Huéscar
  if (appState.folders) {
    appState.folders = appState.folders.filter(f => f.id !== 'general');
  } else {
    appState.folders = [];
  }
  
  // Asegurar que Huéscar y Baza existan
  if (!appState.folders.some(f => f.name.toLowerCase() === 'huéscar' || f.name.toLowerCase() === 'huescar')) {
    appState.folders.push({ id: 'folder-1783121459691', name: 'Huéscar' });
  }
  if (!appState.folders.some(f => f.name.toLowerCase() === 'baza')) {
    appState.folders.push({ id: 'folder-1783155075798', name: 'Baza' });
  }
  
  // 3. Mover cualquier finca con folderId general o sin folderId a Huéscar
  const huescarFolder = appState.folders.find(f => f.name.toLowerCase() === 'huéscar' || f.name.toLowerCase() === 'huescar');
  const huescarId = huescarFolder ? huescarFolder.id : 'folder-1783121459691';
  
  appState.fincas.forEach(f => {
    if (!f.folderId || f.folderId === 'general') {
      f.folderId = huescarId;
    }
  });
  
  // 4. Validar selectedFincaId
  const selectedExists = appState.fincas.some(f => f.id === appState.selectedFincaId);
  if (!selectedExists && appState.fincas.length > 0) {
    appState.selectedFincaId = appState.fincas[0].id;
  }
}

// Guardar datos en localStorage y sincronizar en la nube
function saveData(isLocalChange = true) {
  if (isLocalChange) {
    appState.lastUpdated = Date.now();
  }
  
  localStorage.setItem('fh_fincas', JSON.stringify(appState.fincas));
  localStorage.setItem('fh_incidencias', JSON.stringify(appState.incidencias));
  localStorage.setItem('fh_folders', JSON.stringify(appState.folders));
  localStorage.setItem('fh_shopping_list', JSON.stringify(appState.shoppingList || []));
  localStorage.setItem('fh_checked_supplies', JSON.stringify(appState.checkedIncidentSupplies || []));
  localStorage.setItem('fh_sync_code', appState.syncCode || '');
  localStorage.setItem('fh_last_updated', String(appState.lastUpdated || 0));
  
  // Sincronización en la nube en segundo plano (si hay código activo)
  if (appState.syncCode) {
    fetch(getCloudSyncUrl(appState.syncCode), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(appState)
    }).catch(err => console.error("Background sync error:", err));
  }
}

// --- NAVEGACIÓN SPA ---
function setupNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  const adminBtn = document.getElementById('nav-btn-admin');
  const sections = document.querySelectorAll('.app-section');
  
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetSectionId = item.getAttribute('data-target');
      
      navItems.forEach(n => n.classList.remove('active'));
      adminBtn.classList.remove('active'); // Desactivar botón de admin si se pulsa otro
      sections.forEach(s => s.classList.remove('active'));
      
      item.classList.add('active');
      const targetSection = document.getElementById(targetSectionId);
      targetSection.classList.add('active');
      
      // Ajustar tamaño del mapa si se vuelve a la sección de fincas
      if (targetSectionId === 'section-fincas' && map) {
        setTimeout(() => {
          map.invalidateSize();
        }, 100);
      }
      
      // Renderizar elementos de las listas al cambiar a incidencias
      if (targetSectionId === 'section-incidencias') {
        renderIncidenciasList();
      }
      if (targetSectionId === 'section-compra') {
        renderShoppingList();
        renderIncidentSuppliesChecklist();
      }
    });
  });

  // Botón pequeño de administración (muñequito)
  adminBtn.addEventListener('click', () => {
    // Si la sección de administración ya está activa en pantalla, no hacemos nada
    const adminSection = document.getElementById('section-admin');
    if (adminSection.classList.contains('active')) {
      return;
    }
    openAdminLoginModal();
  });
}

// --- CONFIGURACIÓN DEL MAPA ---
function initMap() {
  const initialFinca = getFincaById(appState.selectedFincaId);
  const mapCenter = initialFinca ? [initialFinca.lat, initialFinca.lng] : [37.7796, -3.7849];
  
  // Capas de mapa
  mapLayers.satellite = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19
  });
  
  // Inicialización de mapa
  map = L.map('map', {
    center: mapCenter,
    zoom: 16,
    layers: [mapLayers.satellite], // Satélite por defecto para ver los campos
    zoomControl: false, // Ocultar control por defecto para una UI limpia
    attributionControl: false // Ocultar barra de atribución inferior (copyright)
  });

  if (initialFinca) {
    restrictMapBounds(initialFinca);
  }
  
  // Reubicar zoom al lado inferior derecho (o simplemente manejarlo por gestos en móvil)
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  
  // Crear grupo para marcadores
  incidentMarkersGroup = L.layerGroup().addTo(map);
  
  // Evento de clic en el mapa para marcar incidencia
  map.on('click', (e) => {
    const { lat, lng } = e.latlng;
    
    // Crear un popup interactivo
    const popupContent = document.createElement('div');
    popupContent.style.padding = '5px 0';
    popupContent.innerHTML = `
      <h4 style="margin: 0 0 6px 0; font-family: 'Outfit', sans-serif;">Marcar Incidencia</h4>
      <p style="margin: 0 0 10px 0; font-size: 0.8rem; color: #666;">¿Deseas registrar un punto aquí?</p>
      <button class="btn btn-primary" id="btn-popup-add" style="width: 100%; padding: 6px 12px; font-size: 0.8rem; border-radius: 8px;">Registrar Incidencia</button>
    `;
    
    L.popup()
      .setLatLng([lat, lng])
      .setContent(popupContent)
      .openOn(map);
      
    // Listener del botón del popup
    setTimeout(() => {
      const btn = document.getElementById('btn-popup-add');
      if (btn) {
        btn.onclick = () => {
          map.closePopup();
          openIncidenciaModal(lat, lng);
        };
      }
    }, 50);
  });
  
  // Evento de clic largo / click secundario
  map.on('contextmenu', (e) => {
    const { lat, lng } = e.latlng;
    openIncidenciaModal(lat, lng);
  });
}



// --- DIBUJAR MARCADORES ---
function updateMapMarkers() {
  if (!map || !incidentMarkersGroup) return;
  
  // Limpiar marcadores existentes
  incidentMarkersGroup.clearLayers();
  
  // Filtrar incidencias de la finca actual
  const currentFincaIncidencias = appState.incidencias.filter(
    inc => inc.fincaId === appState.selectedFincaId
  );
  
  currentFincaIncidencias.forEach(inc => {
    // Si no tiene ubicación física (incidencia general de finca), no dibujar marcador en el mapa
    if (inc.lat === null || inc.lng === null || isNaN(inc.lat) || isNaN(inc.lng)) return;
    
    const markerIcon = createCustomMarkerIcon(false); // Siempre verde oliva/activo
    
    const marker = L.marker([inc.lat, inc.lng], { icon: markerIcon });
    
    let popupDetails = '';
    const combinedSupplies = [inc.materiales, inc.herramientas].filter(Boolean).join(', ');
    if (combinedSupplies) {
      popupDetails += `
        <div style="margin-top: 6px; padding: 6px; background: #f8faf8; border-left: 2px solid var(--primary); border-radius: 2px; font-size: 0.72rem; display: flex; flex-direction: column; gap: 2px; color: #555;">
          <div><strong>Suministros:</strong> ${combinedSupplies}</div>
        </div>
      `;
    }
    
    // Popup del marcador
    const popupContent = `
      <div style="font-family: 'Outfit', sans-serif; min-width: 175px;">
        <h4 style="margin: 0 0 6px 0; font-size: 0.95rem; font-weight: 700; color: var(--primary);">${inc.tipo}</h4>
        <p style="margin: 0 0 8px 0; font-size: 0.75rem; color: #6e7871; line-height: 1.3;">${inc.descripcion || 'Sin notas.'}</p>
        ${popupDetails}
        <div style="display: flex; gap: 4px; margin-top: 8px;">
          <button onclick="quickActionGoToRoute(${inc.lat}, ${inc.lng})" style="flex:1; border: 1px solid #3E5F48; background: #E8EFEA; color:#3E5F48; font-size: 0.7rem; font-weight:600; padding: 4px; border-radius: 4px; cursor:pointer;">Cómo llegar</button>
          <button onclick="completeIncidencia('${inc.id}')" style="border: 1px solid var(--success); background: #E8F5E9; color:var(--success); font-size: 0.75rem; font-weight:700; padding: 4px 8px; border-radius: 4px; cursor:pointer;" title="Marcar como solucionada">✓</button>
          <button onclick="openEditIncidenciaModal('${inc.id}')" style="border: 1px solid #ddd; background: #fff; color:#555; font-size: 0.7rem; font-weight:600; padding: 4px 6px; border-radius: 4px; cursor:pointer;">Editar</button>
        </div>
      </div>
    `;
    
    marker.bindPopup(popupContent);
    incidentMarkersGroup.addLayer(marker);
  });
}

// Crear el icono de marcador personalizado (Pin de color)
function createCustomMarkerIcon(isResolved) {
  let colorClass = isResolved ? 'resuelta' : '';
  
  return L.divIcon({
    className: 'custom-marker-wrapper',
    html: `<div class="marker-pin ${colorClass}"></div>`,
    iconSize: [30, 42],
    iconAnchor: [15, 42],
    popupAnchor: [0, -40]
  });
}

// --- RENDERIZADO GENERAL DE LA INTERFAZ ---
function renderApp() {
  populateFincaSelectors();
  populateFolderDropdowns();
  renderIncidenciasList();
  updateMapMarkers();
  updateIncidenciasBadge();
}

// Rellenar los dropdowns de fincas (agrupadas por carpetas)
function populateFincaSelectors() {
  const mainSelect = document.getElementById('finca-select');
  const filterFincaSelect = document.getElementById('filter-finca');
  const modalFincaSelect = document.getElementById('incidencia-finca');
  
  // Guardar valor seleccionado temporalmente para no perderlo
  const currentMainVal = mainSelect.value || appState.selectedFincaId;
  const currentFilterVal = filterFincaSelect.value || 'all';
  
  // Limpiar
  mainSelect.innerHTML = '';
  filterFincaSelect.innerHTML = '<option value="all">Todas las Fincas</option>';
  modalFincaSelect.innerHTML = '';
  
  if (!appState.folders) {
    appState.folders = [{ id: 'general', name: 'General' }];
  }
  
  // Agrupar fincas por folderId
  appState.folders.forEach(folder => {
    const folderFincas = appState.fincas.filter(f => (f.folderId || 'general') === folder.id);
    
    if (folderFincas.length > 0) {
      const groupMain = document.createElement('optgroup');
      groupMain.label = folder.name;
      
      const groupFilter = document.createElement('optgroup');
      groupFilter.label = folder.name;
      
      const groupModal = document.createElement('optgroup');
      groupModal.label = folder.name;
      
      folderFincas.forEach(finca => {
        const opt1 = document.createElement('option');
        opt1.value = finca.id;
        opt1.textContent = finca.name;
        groupMain.appendChild(opt1);
        
        const opt2 = document.createElement('option');
        opt2.value = finca.id;
        opt2.textContent = finca.name;
        groupFilter.appendChild(opt2);
        
        const opt3 = document.createElement('option');
        opt3.value = finca.id;
        opt3.textContent = finca.name;
        groupModal.appendChild(opt3);
      });
      
      mainSelect.appendChild(groupMain);
      filterFincaSelect.appendChild(groupFilter);
      modalFincaSelect.appendChild(groupModal);
    }
  });
  
  // Fincas huérfanas (sin carpeta válida)
  const orphanedFincas = appState.fincas.filter(f => {
    const fId = f.folderId || 'general';
    return !appState.folders.some(folder => folder.id === fId);
  });
  
  if (orphanedFincas.length > 0) {
    const groupMainOrphan = document.createElement('optgroup');
    groupMainOrphan.label = 'Sin Carpeta';
    
    const groupFilterOrphan = document.createElement('optgroup');
    groupFilterOrphan.label = 'Sin Carpeta';
    
    const groupModalOrphan = document.createElement('optgroup');
    groupModalOrphan.label = 'Sin Carpeta';
    
    orphanedFincas.forEach(finca => {
      const opt1 = document.createElement('option');
      opt1.value = finca.id;
      opt1.textContent = finca.name;
      groupMainOrphan.appendChild(opt1);
      
      const opt2 = document.createElement('option');
      opt2.value = finca.id;
      opt2.textContent = finca.name;
      groupFilterOrphan.appendChild(opt2);
      
      const opt3 = document.createElement('option');
      opt3.value = finca.id;
      opt3.textContent = finca.name;
      groupModalOrphan.appendChild(opt3);
    });
    
    mainSelect.appendChild(groupMainOrphan);
    filterFincaSelect.appendChild(groupFilterOrphan);
    modalFincaSelect.appendChild(groupModalOrphan);
  }
  
  // Restaurar selecciones
  if (appState.fincas.some(f => f.id === currentMainVal)) {
    mainSelect.value = currentMainVal;
    appState.selectedFincaId = currentMainVal;
  } else if (appState.fincas.length > 0) {
    mainSelect.value = appState.fincas[0].id;
    appState.selectedFincaId = appState.fincas[0].id;
  }
  
  filterFincaSelect.value = currentFilterVal;
}

// Rellenar selectores simples de carpeta en los formularios
function populateFolderDropdowns() {
  const modalSelect = document.getElementById('finca-folder-select');
  const drawnSelect = document.getElementById('drawn-finca-folder-select');
  
  if (!appState.folders) {
    appState.folders = [{ id: 'general', name: 'General' }];
  }
  
  let optionsHtml = '';
  appState.folders.forEach(folder => {
    optionsHtml += `<option value="${folder.id}">${folder.name}</option>`;
  });
  
  if (modalSelect) modalSelect.innerHTML = optionsHtml;
  if (drawnSelect) drawnSelect.innerHTML = optionsHtml;
}

// Renderizar la lista de incidencias en la pestaña 2
function renderIncidenciasList() {
  const container = document.getElementById('incidencias-list-container');
  const searchTerm = document.getElementById('search-incidencia').value.toLowerCase();
  const filterFinca = document.getElementById('filter-finca').value;
  
  container.innerHTML = '';
  
  // Filtrar
  const filtered = appState.incidencias.filter(inc => {
    const finca = getFincaById(inc.fincaId);
    const fincaName = finca ? finca.name : '';
    
    // Filtro por texto (título o descripción)
    const matchesSearch = inc.tipo.toLowerCase().includes(searchTerm) || 
                          inc.descripcion.toLowerCase().includes(searchTerm) ||
                          fincaName.toLowerCase().includes(searchTerm);
                          
    // Filtro por finca
    const matchesFinca = filterFinca === 'all' || inc.fincaId === filterFinca;
    
    return matchesSearch && matchesFinca;
  });
  
  // Ordenar: De más reciente a más antigua
  filtered.sort((a, b) => new Date(b.fecha) - new Date(a.fecha));
  
  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" class="empty-icon"><circle cx="12" cy="12" r="10"/><path d="M8 9.5h.01"/><path d="M16 9.5h.01"/><path d="M16 16c0-2-4-2.5-4-2.5s-4 .5-4 2.5"/></svg>
        <h3>No se encontraron incidencias</h3>
        <p>Marca una nueva incidencia en el mapa de las fincas o cambia el filtro de búsqueda.</p>
      </div>
    `;
    return;
  }
  
  filtered.forEach(inc => {
    const finca = getFincaById(inc.fincaId);
    const dateFormatted = new Date(inc.fecha).toLocaleDateString('es-ES', {
      day: 'numeric',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit'
    });
    
    const card = document.createElement('div');
    card.className = `incidencia-card`;
    
    const hasCoords = inc.lat !== null && inc.lng !== null && !isNaN(inc.lat) && !isNaN(inc.lng);
    const locationTag = hasCoords ? '' : '<span style="font-size:0.7rem; color:var(--text-muted); border:1px solid var(--border); padding:2px 6px; border-radius:10px; background:#fafafa; font-weight:500; margin-left: 6px;">General</span>';
    
    let detailsHtml = '';
    const combinedSupplies = [inc.materiales, inc.herramientas].filter(Boolean).join(', ');
    if (combinedSupplies) {
      detailsHtml += `
        <div class="card-details-box" style="margin-top: 8px; padding: 10px; background: rgba(0,0,0,0.02); border-left: 3px solid var(--primary-light); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; font-size: 0.8rem; display: flex; flex-direction: column; gap: 4px;">
          <div style="display:flex; align-items:flex-start; gap:4px;"><span>🛠️</span> <span><strong>Materiales y Herramientas:</strong> ${combinedSupplies}</span></div>
        </div>
      `;
    }
    
    let actionsHtml = '';
    if (hasCoords) {
      actionsHtml = `
        <button class="btn-card-action btn-route" onclick="quickActionGoToRoute(${inc.lat}, ${inc.lng})">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" class="icon-btn-left" style="width:14px; height:14px;"><polygon points="3 11 22 2 13 21 11 13 3 11"/></svg>
          Cómo llegar
        </button>
        <button class="btn-card-action" onclick="quickActionFocusOnMap('${inc.id}', '${inc.fincaId}')">
          Ver en Mapa
        </button>
      `;
    }
    actionsHtml += `
      <button class="btn-card-action" onclick="openEditIncidenciaModal('${inc.id}')">
        Editar
      </button>
    `;
    
    card.innerHTML = `
      <div class="card-header">
        <div class="card-title-group">
          <div style="display:flex; align-items:center; gap:2px; flex-wrap:wrap;">
            <span class="card-finca-tag">${finca ? finca.name : 'Finca Desconocida'}</span>
            ${locationTag}
          </div>
          <h3 class="card-title" style="margin-top: 4px;">
            ${getIncidenciaIcon(inc.tipo)}
            ${inc.tipo}
          </h3>
          <span class="card-date">${dateFormatted}</span>
        </div>
        
        <button class="btn-complete-tick" onclick="event.stopPropagation(); this.classList.add('ticked'); setTimeout(() => completeIncidencia('${inc.id}'), 200)" title="Completar y quitar incidencia">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
        </button>
      </div>
      
      <p class="card-body">${inc.descripcion || 'Sin descripción adicional.'}</p>
      ${detailsHtml}
      
      <div class="card-actions">
        ${actionsHtml}
      </div>
    `;
    
    container.appendChild(card);
  });
}

// Icono decorativo según tipo de incidencia
function getIncidenciaIcon(tipo) {
  let iconSvg = '';
  switch (tipo) {
    case 'Goma rota':
    case 'Avería de riego':
      iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px; height:18px; color: #1E3A8A;"><path d="M12 22a7 7 0 0 0 7-7c0-4.3-7-11-7-11S5 10.7 5 15a7 7 0 0 0 7 7z"/></svg>';
      break;
    case 'Almendro seco':
    case 'Olivo enfermo':
    case 'Pistacho dañado':
      iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px; height:18px; color: #047857;"><path d="M12 22v-5"/><path d="M9 12c.5-2.5 1-5 3-5s2.5 2.5 3 5"/><path d="M12 7c2-2.5 4.5-2.5 6 0s-.5 4.5-3 5"/><path d="M12 7c-2-2.5-4.5-2.5-6 0s.5 4.5 3 5"/></svg>';
      break;
    case 'Tubo obstruido':
    case 'Válvula rota':
      iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px; height:18px; color: #B45309;"><circle cx="12" cy="12" r="10"/><path d="M12 8v8"/><path d="M8 12h8"/></svg>';
      break;
    default:
      iconSvg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px; height:18px; color: #4B5563;"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
  }
  return iconSvg;
}

// Renderizar la lista de fincas en la pestaña de Ajustes
function renderFincasSettingsList() {
  const container = document.getElementById('fincas-settings-list');
  container.innerHTML = '';
  
  appState.fincas.forEach(finca => {
    const item = document.createElement('div');
    item.className = 'finca-settings-item';
    
    // Contar incidencias asociadas
    const count = appState.incidencias.filter(i => i.fincaId === finca.id).length;
    
    item.innerHTML = `
      <div class="finca-info-group">
        <span class="finca-info-name">${finca.name}</span>
        <span class="finca-info-meta">Coords: ${finca.lat.toFixed(4)}, ${finca.lng.toFixed(4)} | ${count} incidencias</span>
      </div>
      <button class="btn-delete-finca" onclick="deleteFincaAction('${finca.id}')" title="Eliminar finca">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="icon-sm"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
      </button>
    `;
    
    container.appendChild(item);
  });
}

// Actualizar el número de incidencias pendientes en el botón de menú inferior
function updateIncidenciasBadge() {
  const badge = document.getElementById('incidencias-badge');
  const pendingCount = appState.incidencias.length;
  
  if (pendingCount > 0) {
    badge.textContent = pendingCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// --- CONFIGURACIÓN DE EVENT LISTENERS ---
function setupEventListeners() {
  // Cambio de Finca en el selector principal
  document.getElementById('finca-select').addEventListener('change', (e) => {
    appState.selectedFincaId = e.target.value;
    const finca = getFincaById(appState.selectedFincaId);
    if (finca && map) {
      map.setView([finca.lat, finca.lng], 16);
      restrictMapBounds(finca);
      updateMapMarkers();
    }
  });



  // Botón Centrar GPS en el mapa
  document.getElementById('btn-gps').addEventListener('click', () => {
    if (lastGpsPosition && map) {
      map.setView(lastGpsPosition, 18);
    } else {
      alert("Obteniendo ubicación GPS en tiempo real. Por favor, asegúrate de haber dado permisos de ubicación.");
    }
  });

  // Filtros de Incidencias
  document.getElementById('search-incidencia').addEventListener('input', renderIncidenciasList);
  document.getElementById('filter-finca').addEventListener('change', renderIncidenciasList);

  // Botón de deshacer (Toast)
  document.getElementById('btn-undo-delete').addEventListener('click', () => {
    if (lastDeletedIncidencia) {
      appState.incidencias.push(lastDeletedIncidencia);
      saveData();
      lastDeletedIncidencia = null;
    } else if (lastDeletedShoppingItem) {
      appState.shoppingList.push(lastDeletedShoppingItem);
      saveData();
      lastDeletedShoppingItem = null;
    } else if (lastDeletedIncidentSupplyKey) {
      if (appState.checkedIncidentSupplies) {
        const idx = appState.checkedIncidentSupplies.indexOf(lastDeletedIncidentSupplyKey);
        if (idx !== -1) {
          appState.checkedIncidentSupplies.splice(idx, 1);
        }
      }
      saveData();
      lastDeletedIncidentSupplyKey = null;
    }
    
    if (undoTimeout) {
      clearTimeout(undoTimeout);
      undoTimeout = null;
    }
    
    document.getElementById('undo-toast').classList.remove('active');
    renderApp();
  });

  // --- MODAL DE INCIDENCIAS ---
  const modalInc = document.getElementById('modal-incidencia');
  const btnCloseInc1 = document.getElementById('btn-close-modal-incidencia');
  const btnCloseInc2 = document.getElementById('btn-cancel-incidencia');
  
  const closeModalInc = () => modalInc.classList.remove('active');
  
  btnCloseInc1.addEventListener('click', closeModalInc);
  btnCloseInc2.addEventListener('click', closeModalInc);
  


  // Botón para crear incidencia general (sin localización física)
  document.getElementById('btn-add-general-incidencia').addEventListener('click', () => {
    openIncidenciaModal(null, null);
  });

  // Envío del formulario de incidencias
  document.getElementById('form-incidencia').addEventListener('submit', (e) => {
    e.preventDefault();
    saveIncidenciaForm();
  });

  // --- SUB-PESTAÑAS DE SECCIÓN COMPRA ---
  const tabBtns = document.querySelectorAll('.compra-tab-btn');
  const tabContents = document.querySelectorAll('.compra-tab-content');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.style.display = 'none');
      
      btn.classList.add('active');
      document.getElementById(targetId).style.display = 'flex';
      
      if (targetId === 'tab-compra-manual') {
        renderShoppingList();
      } else {
        renderIncidentSuppliesChecklist();
      }
    });
  });

  // Botón añadir compra manual
  document.getElementById('btn-add-compra').addEventListener('click', addManualShoppingItem);
  document.getElementById('input-new-compra').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') addManualShoppingItem();
  });

  // Botón añadir compra por voz (dictado rápido)
  document.getElementById('btn-add-compra-voice').addEventListener('click', startQuickVoiceShopping);

  // Botón de activación del Asistente de Voz Principal
  document.getElementById('btn-voice-assistant').addEventListener('click', startVoiceAssistant);
  document.getElementById('btn-voice-close').addEventListener('click', stopVoiceAssistant);

}

// Limitar los movimientos del mapa alrededor de la finca activa (máscara o límites estándar)
function restrictMapBounds(finca) {
  if (!map) return;
  
  // Limpiar máscara anterior si existe
  if (fincaMaskLayer) {
    map.removeLayer(fincaMaskLayer);
    fincaMaskLayer = null;
  }
  
  const lat = finca.lat;
  const lng = finca.lng;
  
  map.setMinZoom(14);
  map.setMaxZoom(19);
  
  if (finca.polygon && finca.polygon.length > 0) {
    // Si tiene polígono de máscara, dibujar máscara negra en el mapa
    const worldCoords = [
      [-90, -180],
      [-90, 180],
      [90, 180],
      [90, -180]
    ];
    
    // Dibujar máscara invertida (el segundo array representa el "agujero" en la máscara)
    fincaMaskLayer = L.polygon([worldCoords, finca.polygon], {
      color: '#000000',
      fillColor: '#000000',
      fillOpacity: 1.0, // Negro total fuera de la finca
      stroke: false,
      interactive: false // Para poder hacer click en el mapa a través de la máscara
    }).addTo(map);
    
    // Auto-ajustar cámara a los límites del polígono
    const polygonLayer = L.polygon(finca.polygon);
    const polyBounds = polygonLayer.getBounds();
    map.fitBounds(polyBounds);
    
    // Permitir arrastrar solo con un margen de 20% sobre la finca
    map.setMaxBounds(polyBounds.pad(0.2));
  } else {
    // Si no tiene polígono, usar límites por defecto (caja de 500m)
    const offset = 0.005;
    const southWest = L.latLng(lat - offset, lng - offset);
    const northEast = L.latLng(lat + offset, lng + offset);
    const bounds = L.latLngBounds(southWest, northEast);
    
    map.setMaxBounds(bounds);
  }
}

// --- OPERACIONES CRUD ---

// Abrir modal para nueva incidencia (admite lat/lng nulos para incidencias generales)
function openIncidenciaModal(lat, lng) {
  const modal = document.getElementById('modal-incidencia');
  document.getElementById('form-incidencia').reset();
  
  document.getElementById('modal-title').textContent = 'Registrar Incidencia';
  document.getElementById('incidencia-id').value = '';
  document.getElementById('incidencia-finca').value = appState.selectedFincaId;
  document.getElementById('incidencia-tipo').value = '';
  document.getElementById('incidencia-desc').value = '';
  document.getElementById('incidencia-materiales').value = '';
  
  const isGeneral = lat === null || lng === null;
  if (isGeneral) {
    document.getElementById('incidencia-lat').value = '';
    document.getElementById('incidencia-lng').value = '';
    document.getElementById('coordinates-text').textContent = 'Incidencia General (Sin ubicación en el mapa)';
  } else {
    document.getElementById('incidencia-lat').value = lat;
    document.getElementById('incidencia-lng').value = lng;
    document.getElementById('coordinates-text').textContent = `Lat: ${lat.toFixed(6)}, Lng: ${lng.toFixed(6)}`;
  }
  
  modal.classList.add('active');
}

// Abrir modal para editar incidencia existente
function openEditIncidenciaModal(id) {
  if (map) map.closePopup(); // Cerrar popups del mapa si están abiertos
  
  const inc = appState.incidencias.find(i => i.id === id);
  if (!inc) return;
  
  const modal = document.getElementById('modal-incidencia');
  document.getElementById('form-incidencia').reset();
  
  document.getElementById('modal-title').textContent = 'Editar Incidencia';
  document.getElementById('incidencia-id').value = inc.id;
  document.getElementById('incidencia-finca').value = inc.fincaId;
  document.getElementById('incidencia-tipo').value = inc.tipo;
  document.getElementById('incidencia-desc').value = inc.descripcion || '';
  
  // Combinar campos antiguos para compatibilidad hacia atrás
  const combinedSupplies = [inc.materiales, inc.herramientas].filter(Boolean).join(', ');
  document.getElementById('incidencia-materiales').value = combinedSupplies;
  
  const hasCoords = inc.lat !== null && inc.lng !== null && !isNaN(inc.lat) && !isNaN(inc.lng);
  if (hasCoords) {
    document.getElementById('incidencia-lat').value = inc.lat;
    document.getElementById('incidencia-lng').value = inc.lng;
    document.getElementById('coordinates-text').textContent = `Lat: ${Number(inc.lat).toFixed(6)}, Lng: ${Number(inc.lng).toFixed(6)}`;
  } else {
    document.getElementById('incidencia-lat').value = '';
    document.getElementById('incidencia-lng').value = '';
    document.getElementById('coordinates-text').textContent = 'Incidencia General (Sin ubicación en el mapa)';
  }
  
  modal.classList.add('active');
}

// Guardar los datos del formulario de incidencia
function saveIncidenciaForm() {
  const id = document.getElementById('incidencia-id').value;
  const fincaId = document.getElementById('incidencia-finca').value;
  const tipo = document.getElementById('incidencia-tipo').value.trim();
  const descripcion = document.getElementById('incidencia-desc').value.trim();
  const materiales = document.getElementById('incidencia-materiales').value.trim();
  
  const latVal = document.getElementById('incidencia-lat').value;
  const lngVal = document.getElementById('incidencia-lng').value;
  const lat = latVal === '' ? null : parseFloat(latVal);
  const lng = lngVal === '' ? null : parseFloat(lngVal);
  const estado = 'Pendiente';
  
  if (!tipo) {
    alert("Introduce el tipo de incidencia.");
    return;
  }
  
  if (id) {
    // Editar existente
    const index = appState.incidencias.findIndex(i => i.id === id);
    if (index !== -1) {
      appState.incidencias[index] = {
        ...appState.incidencias[index],
        fincaId,
        tipo,
        descripcion,
        materiales,
        herramientas: '', // Campo unificado en materiales
        lat,
        lng,
        estado
      };
    }
  } else {
    // Nueva incidencia
    const newInc = {
      id: 'inc-' + Date.now(),
      fincaId,
      tipo,
      descripcion,
      materiales,
      herramientas: '', // Campo unificado en materiales
      estado,
      lat,
      lng,
      fecha: new Date().toISOString()
    };
    appState.incidencias.push(newInc);
  }
  
  saveData();
  document.getElementById('modal-incidencia').classList.remove('active');
  
  // Mantener la finca del formulario como seleccionada en la vista de mapa
  appState.selectedFincaId = fincaId;
  document.getElementById('finca-select').value = fincaId;
  
  renderApp();
}



// Eliminar una Finca
function deleteFincaAction(fincaId) {
  const finca = getFincaById(fincaId);
  if (!finca) return;
  
  // Impedir eliminar si es la última finca
  if (appState.fincas.length <= 1) {
    alert("No puedes eliminar la única finca activa. Debes añadir otra antes de eliminar esta.");
    return;
  }
  
  const asociadas = appState.incidencias.filter(i => i.fincaId === fincaId);
  
  let confirmMsg = `¿Estás seguro de que quieres eliminar la finca "${finca.name}"?`;
  if (asociadas.length > 0) {
    confirmMsg += `\n\nEsta finca contiene ${asociadas.length} incidencias. Si aceptas, también se eliminarán de forma definitiva todas sus incidencias asociadas.`;
  }
  
  if (confirm(confirmMsg)) {
    // Borrar incidencias asociadas
    appState.incidencias = appState.incidencias.filter(i => i.fincaId !== fincaId);
    
    // Borrar finca
    appState.fincas = appState.fincas.filter(f => f.id !== fincaId);
    
    // Cambiar finca seleccionada si borramos la activa
    if (appState.selectedFincaId === fincaId) {
      appState.selectedFincaId = appState.fincas[0].id;
    }
    
    saveData();
    renderApp();
    renderFincasSettingsList();
    
    // Centrar mapa en la finca activa restante
    const activeFinca = getFincaById(appState.selectedFincaId);
    if (activeFinca && map) {
      map.setView([activeFinca.lat, activeFinca.lng], 16);
    }
  }
}

// --- ACCIONES RÁPIDAS DESDE LAS LISTAS ---

// Botón "Cómo llegar" (Abre Google Maps con ruta)
function quickActionGoToRoute(lat, lng) {
  // Abre Google Maps en una pestaña nueva con el punto de destino
  const url = `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}`;
  window.open(url, '_blank');
}

// Botón "Ver en Mapa" (Cambia de tab y centra el mapa)
function quickActionFocusOnMap(incidenciaId, fincaId) {
  const inc = appState.incidencias.find(i => i.id === incidenciaId);
  if (!inc) return;
  
  // Cambiar pestaña del selector de navegación al mapa (Fincas)
  document.getElementById('nav-btn-fincas').click();
  
  // Seleccionar la finca correcta en el dropdown
  appState.selectedFincaId = fincaId;
  document.getElementById('finca-select').value = fincaId;
  
  const finca = getFincaById(fincaId);
  if (finca) {
    restrictMapBounds(finca);
  }
  
  // Forzar actualización de marcadores de esa finca y enfocar la incidencia
  updateMapMarkers();
  
  if (map) {
    map.setView([inc.lat, inc.lng], 18);
    
    // Encontrar el marcador correspondiente en Leaflet para abrir su popup
    setTimeout(() => {
      incidentMarkersGroup.eachLayer(marker => {
        if (marker.getLatLng().lat === inc.lat && marker.getLatLng().lng === inc.lng) {
          marker.openPopup();
        }
      });
    }, 200);
  }
}

// Completar incidencia (quitar y mostrar deshacer 3s)
function completeIncidencia(id) {
  const index = appState.incidencias.findIndex(i => i.id === id);
  if (index === -1) return;
  
  // Guardar copia para restaurar
  lastDeletedIncidencia = appState.incidencias[index];
  lastDeletedShoppingItem = null;
  lastDeletedIncidentSupplyKey = null;
  
  // Eliminar del estado
  appState.incidencias.splice(index, 1);
  
  // Limpiar suministros tachados de esta incidencia
  appState.checkedIncidentSupplies = (appState.checkedIncidentSupplies || []).filter(k => !k.startsWith(id));
  
  saveData();
  
  // Renderizar
  renderApp();
  
  // Mostrar Toast de Deshacer
  const undoToast = document.getElementById('undo-toast');
  undoToast.querySelector('span').textContent = 'Incidencia completada';
  undoToast.classList.add('active');
  
  if (undoTimeout) {
    clearTimeout(undoTimeout);
  }
  
  undoTimeout = setTimeout(() => {
    undoToast.classList.remove('active');
    lastDeletedIncidencia = null;
  }, 3000);
}

// --- GEOLOCALIZACIÓN GPS EN TIEMPO REAL ---
function startGpsTracking() {
  if ("geolocation" in navigator) {
    navigator.geolocation.watchPosition(
      (position) => {
        const { latitude, longitude, accuracy } = position.coords;
        lastGpsPosition = [latitude, longitude];
        
        // Actualizar etiqueta del estado GPS
        const gpsStatus = document.getElementById('gps-status');
        gpsStatus.innerHTML = `
          <span class="status-dot green"></span>
          <span class="status-text">GPS Activo (±${Math.round(accuracy)}m)</span>
        `;
        
        // Si el mapa ya está cargado, dibujar o mover el marcador del usuario
        if (map) {
          const userIcon = L.divIcon({
            className: 'gps-user-marker-wrapper',
            html: '<div class="gps-user-marker"></div>',
            iconSize: [20, 20],
            iconAnchor: [10, 10]
          });
          
          if (!gpsUserMarker) {
            gpsUserMarker = L.marker(lastGpsPosition, { icon: userIcon }).addTo(map);
            gpsUserCircle = L.circle(lastGpsPosition, {
              radius: accuracy,
              color: '#3B82F6',
              fillColor: '#3B82F6',
              fillOpacity: 0.1,
              weight: 1
            }).addTo(map);
          } else {
            gpsUserMarker.setLatLng(lastGpsPosition);
            gpsUserCircle.setLatLng(lastGpsPosition);
            gpsUserCircle.setRadius(accuracy);
          }
        }
      },
      (error) => {
        console.warn("Error de geolocalización:", error.message);
        const gpsStatus = document.getElementById('gps-status');
        gpsStatus.innerHTML = `
          <span class="status-dot red"></span>
          <span class="status-text">Sin Señal GPS</span>
        `;
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 10000
      }
    );
  } else {
    const gpsStatus = document.getElementById('gps-status');
    gpsStatus.innerHTML = `
      <span class="status-dot red"></span>
      <span class="status-text">GPS No Soportado</span>
    `;
  }
}

// --- COPIAS DE SEGURIDAD (IMPORTACIÓN/EXPORTACIÓN) ---

// Exportar copia de seguridad (Descargar JSON)
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

// Importar copia de seguridad (Leer JSON)
function importBackup(e) {
  const file = e.target.files[0];
  if (!file) return;
  
  const reader = new FileReader();
  reader.onload = function(evt) {
    try {
      const importedData = JSON.parse(evt.target.result);
      
      // Validación elemental de campos
      if (importedData.fincas && Array.isArray(importedData.fincas) && 
          importedData.incidencias && Array.isArray(importedData.incidencias)) {
        
        if (confirm(`Se han detectado ${importedData.fincas.length} fincas y ${importedData.incidencias.length} incidencias en el archivo. ¿Deseas sobreescribir tus datos locales con esta copia?`)) {
          const currentSyncCode = appState.syncCode; // Preservar código de sincronización
          appState = importedData;
          appState.syncCode = currentSyncCode; // Restaurar código
          
          if (!appState.folders) {
            appState.folders = [{ id: 'general', name: 'General' }];
          }
          if (!appState.shoppingList) {
            appState.shoppingList = [];
          }
          if (!appState.checkedIncidentSupplies) {
            appState.checkedIncidentSupplies = [];
          }
          appState.fincas.forEach(f => {
            if (!f.folderId) f.folderId = 'general';
          });
          
          // Asegurar que la finca seleccionada sea válida
          const selectedExists = appState.fincas.some(f => f.id === appState.selectedFincaId);
          if (!selectedExists && appState.fincas.length > 0) {
            appState.selectedFincaId = appState.fincas[0].id;
          }
          
          saveData(); // Guarda localmente y sube automáticamente a la nube
          renderApp();
          
          // Centrar el mapa en la finca activa importada
          const initialFinca = getFincaById(appState.selectedFincaId);
          if (initialFinca && map) {
            map.setView([initialFinca.lat, initialFinca.lng], 16);
            restrictMapBounds(initialFinca);
          }
          
          alert("Datos importados con éxito y sincronizados con todos tus dispositivos.");
        }
      } else {
        alert("El archivo JSON no tiene un formato compatible con FincasSerrano.");
      }
    } catch (err) {
      alert("Error al procesar el archivo. Asegúrate de que sea un archivo JSON válido.");
      console.error(err);
    }
  };
  reader.readAsText(file);
}

// Restablecer aplicación (Reset completo)
function resetDatabase() {
  if (confirm("¿Estás seguro de que quieres restablecer la aplicación? Se perderán todas tus fincas e incidencias personalizadas y se restaurarán los valores predeterminados de ejemplo.")) {
    localStorage.removeItem('fh_fincas');
    localStorage.removeItem('fh_incidencias');
    localStorage.removeItem('fh_folders');
    initData();
    renderApp();
    renderFincasSettingsList();
    renderFoldersSettingsList();
    
    // Centrar mapa
    const initialFinca = getFincaById(appState.selectedFincaId);
    if (initialFinca && map) {
      map.setView([initialFinca.lat, initialFinca.lng], 16);
    }
    
    alert("Aplicación restablecida con éxito.");
  }
}

// --- FUNCIONES AUXILIARES ---
function getFincaById(id) {
  return appState.fincas.find(f => f.id === id);
}


// ==========================================
// LÓGICA DE ADMINISTRACIÓN CONSOLIDADA (MISMA PÁGINA)
// ==========================================

const ADMIN_PASSWORD = "Manuel1214$";
const WEB_PASSWORD = "12345678";

// Abrir el modal de login de administración
function openAdminLoginModal() {
  const modal = document.getElementById('modal-admin-login');
  document.getElementById('form-admin-login').reset();
  document.getElementById('admin-login-error').style.display = 'none';
  modal.classList.add('active');
}

// Cerrar el modal de login
function closeAdminLoginModal() {
  document.getElementById('modal-admin-login').classList.remove('active');
}

// Navegar a la sección de administración una vez autenticado
function goToAdminSection() {
  const navItems = document.querySelectorAll('.nav-item');
  const adminBtn = document.getElementById('nav-btn-admin');
  const sections = document.querySelectorAll('.app-section');
  
  navItems.forEach(n => n.classList.remove('active'));
  adminBtn.classList.add('active');
  
  sections.forEach(s => s.classList.remove('active'));
  const targetSection = document.getElementById('section-admin');
  targetSection.classList.add('active');
  
  // Renderizar listado de fincas, carpetas y sincronización
  renderFoldersSettingsList();
  renderFincasSettingsList();
  updateCloudSyncUI();
  
  // Inicializar mapa de dibujo en diferido
  setTimeout(() => {
    initAdminMap();
  }, 100);
}

// Escuchadores de eventos para la administración en la página principal
function setupAdminEventListeners() {
  // Envío de contraseña del login
  document.getElementById('form-admin-login').addEventListener('submit', (e) => {
    e.preventDefault();
    const passwordInput = document.getElementById('admin-pass-input');
    const errorText = document.getElementById('admin-login-error');
    
    if (passwordInput.value === ADMIN_PASSWORD) {
      sessionStorage.setItem('fs_auth', 'true');
      errorText.style.display = 'none';
      closeAdminLoginModal();
      goToAdminSection();
    } else {
      errorText.style.display = 'block';
      passwordInput.value = '';
      passwordInput.focus();
    }
  });

  const modalLogin = document.getElementById('modal-admin-login');
  document.getElementById('btn-close-modal-admin-login').addEventListener('click', closeAdminLoginModal);
  document.getElementById('btn-cancel-admin-login').addEventListener('click', closeAdminLoginModal);
  document.getElementById('modal-admin-login-overlay').addEventListener('click', closeAdminLoginModal);

  // Pestañas de administración (Configuración / Dibujar)
  const tabBtns = document.querySelectorAll('.admin-tab-btn');
  const tabContents = document.querySelectorAll('.admin-tab-content');
  
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => {
        c.style.display = 'none';
        c.classList.remove('active');
      });
      
      btn.classList.add('active');
      const targetTab = document.getElementById(targetId);
      targetTab.style.display = 'flex';
      targetTab.classList.add('active');
      
      if (targetId === 'tab-seleccion' && adminMap) {
        setTimeout(() => {
          adminMap.invalidateSize();
        }, 150);
      }
    });
  });

  // Copias de seguridad en panel de administración
  document.getElementById('btn-export-backup').addEventListener('click', exportBackup);
  document.getElementById('input-import-backup').addEventListener('change', importBackup);
  document.getElementById('btn-reset-db').addEventListener('click', resetDatabase);

  // Gestión de carpetas
  document.getElementById('btn-create-folder').addEventListener('click', createFolder);

  // Sincronización en la Nube
  document.getElementById('btn-generate-sync-code').addEventListener('click', generateCloudSyncGroup);
  document.getElementById('btn-connect-sync-code').addEventListener('click', connectToCloudSyncGroup);
  document.getElementById('btn-force-sync').addEventListener('click', forceCloudSync);
  document.getElementById('btn-disconnect-sync').addEventListener('click', disconnectCloudSync);

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

  // Pantalla completa para el mapa de dibujo
  const fsBtn = document.getElementById('btn-draw-fullscreen');
  const mapWrapper = document.querySelector('.draw-map-wrapper');
  fsBtn.addEventListener('click', () => {
    const isFS = mapWrapper.classList.toggle('fullscreen');
    if (isFS) {
      fsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 14h6v6m10-6h-6v6M4 10h6V4m10 6h-6V4"/></svg>';
      fsBtn.title = "Salir de pantalla completa";
    } else {
      fsBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"/></svg>';
      fsBtn.title = "Pantalla completa";
    }
    setTimeout(() => {
      if (adminMap) adminMap.invalidateSize();
    }, 150);
  });

  // --- BUSCADOR GEOGRÁFICO ---
  document.getElementById('btn-admin-search-submit').addEventListener('click', executeLocationSearch);
  document.getElementById('input-admin-search').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      executeLocationSearch();
    }
  });
}

// Renderizado de la lista de fincas en la pestaña Configuración
function renderFincasSettingsList() {
  const container = document.getElementById('fincas-settings-list');
  container.innerHTML = '';
  
  if (appState.fincas.length === 0) {
    container.innerHTML = '<p style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 12px 0;">No hay fincas guardadas en el sistema.</p>';
    return;
  }
  
  appState.fincas.forEach(finca => {
    const item = document.createElement('div');
    item.className = 'finca-settings-item';
    item.style.display = 'flex';
    item.style.justifyContent = 'space-between';
    item.style.alignItems = 'center';
    item.style.padding = '12px';
    item.style.backgroundColor = 'var(--bg)';
    item.style.borderRadius = 'var(--radius-sm)';
    item.style.border = '1px solid var(--border)';
    item.style.marginBottom = '8px';
    item.style.gap = '10px';
    
    const count = appState.incidencias.filter(i => i.fincaId === finca.id).length;
    const hasBoundary = finca.polygon && finca.polygon.length > 0;
    const boundaryTag = hasBoundary ? 'Linde dibujada' : 'Solo coords';
    const boundaryStyle = hasBoundary ? 'color: var(--primary); font-weight:600;' : 'color: var(--text-muted);';
    
    const folderName = getFolderName(finca.folderId || 'general');
    
    // Generar opciones del select de carpetas
    if (!appState.folders) {
      appState.folders = [{ id: 'general', name: 'General' }];
    }
    let folderOptions = '';
    appState.folders.forEach(folder => {
      const selected = (finca.folderId || 'general') === folder.id ? 'selected' : '';
      folderOptions += `<option value="${folder.id}" ${selected}>${folder.name}</option>`;
    });
    
    item.innerHTML = `
      <div class="finca-info-group" style="flex: 1; min-width: 0;">
        <span class="finca-info-name" style="font-weight:600; display:block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${finca.name}</span>
        <span class="finca-info-meta" style="font-size:0.72rem; color:var(--text-muted); display:block; margin-top: 2px;">
          ${finca.lat.toFixed(4)}, ${finca.lng.toFixed(4)} | 
          <span style="${boundaryStyle}">${boundaryTag}</span> | 
          ${count} inc.
        </span>
        <span style="font-size: 0.72rem; color: var(--text-muted); display:block; margin-top: 1px;">Carpeta: <strong style="color: var(--primary);">${folderName}</strong></span>
      </div>
      <div style="display: flex; align-items: center; gap: 8px; flex-shrink: 0;">
        <select class="form-select" style="font-size: 0.75rem; padding: 4px 20px 4px 8px; height: 28px; width: 105px; border-color: var(--border);" onchange="moveFincaToFolder('${finca.id}', this.value)">
          ${folderOptions}
        </select>
        <button class="btn-delete-finca" onclick="deleteFincaAction('${finca.id}')" title="Eliminar finca" style="background:none; border:none; color:var(--danger); cursor:pointer; padding:6px; display: flex; align-items: center; justify-content: center;">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:18px; height:18px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      </div>
    `;
    
    container.appendChild(item);
  });
}

// Eliminar Finca
window.deleteFincaAction = function(fincaId) {
  const finca = appState.fincas.find(f => f.id === fincaId);
  if (!finca) return;
  
  if (appState.fincas.length <= 1) {
    alert("No puedes eliminar la única finca activa. Debes registrar otra antes.");
    return;
  }
  
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
    
    saveData();
    renderApp();
    renderFincasSettingsList();
  }
};

// Inicializar el mapa satélite en el panel de administración
function initAdminMap() {
  if (adminMap) return;
  
  adminMap = L.map('admin-map', {
    center: [37.7796, -3.7849],
    zoom: 15,
    zoomControl: true,
    attributionControl: false
  });
  
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19
  }).addTo(adminMap);
  
  adminMap.on('click', handleMapClickForDrawing);
  adminMap.on('dblclick', handleMapDblClickForDrawing);
}

// Buscar localización en el admin
async function executeLocationSearch() {
  const query = document.getElementById('input-admin-search').value.trim();
  const resultsContainer = document.getElementById('search-results-list');
  resultsContainer.innerHTML = '';
  resultsContainer.style.display = 'none';
  
  if (!query) return;

  const coordRegex = /^[-+]?([1-9]?\d(\.\d+)?|90(\.0+)?),\s*[-+]?(180(\.0+)?|((1[0-7]\d)|([1-9]?\d))(\.\d+)?)$/;
  if (coordRegex.test(query)) {
    const parts = query.split(',');
    const lat = parseFloat(parts[0]);
    const lng = parseFloat(parts[1]);
    
    if (adminMap) {
      adminMap.setView([lat, lng], 17);
      const tempMarker = L.marker([lat, lng]).addTo(adminMap);
      setTimeout(() => adminMap.removeLayer(tempMarker), 4000);
    }
    return;
  }

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
      alert("No se encontraron resultados.");
    }
  } catch (err) {
    console.error(err);
    alert("Error de búsqueda.");
  }
}

// Trazado del polígono
function toggleDrawingMode() {
  const btn = document.getElementById('btn-draw-pencil');
  const statusText = document.getElementById('draw-status-text');
  
  if (!isDrawingMode) {
    isDrawingMode = true;
    btn.classList.add('active');
    statusText.textContent = "Toca el mapa para situar esquinas. Clica en el primer punto para cerrar.";
    
    if (adminMap) {
      adminMap.doubleClickZoom.disable();
    }
    clearDrawing();
  } else {
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
  
  if (drawnPoints.length >= 3) {
    const firstPoint = L.latLng(drawnPoints[0][0], drawnPoints[0][1]);
    const dist = adminMap.distance(e.latlng, firstPoint);
    if (dist < 15) {
      finishDrawing();
      return;
    }
  }
  
  drawnPoints.push([lat, lng]);
  
  const marker = L.circleMarker([lat, lng], {
    radius: 6,
    color: '#FF6B6B',
    fillColor: '#FFFFFF',
    fillOpacity: 1,
    weight: 2.5
  }).addTo(adminMap);
  
  if (drawnPoints.length === 1) {
    marker.on('click', (ev) => {
      L.DomEvent.stopPropagation(ev);
      if (drawnPoints.length >= 3) {
        finishDrawing();
      }
    });
  }
  
  drawingMarkers.push(marker);
  
  if (drawingPolyline) {
    adminMap.removeLayer(drawingPolyline);
  }
  drawingPolyline = L.polyline(drawnPoints, {
    color: '#FF6B6B',
    dashArray: '5, 5',
    weight: 3
  }).addTo(adminMap);
  
  document.getElementById('btn-draw-clear').removeAttribute('disabled');
}

function handleMapDblClickForDrawing(e) {
  if (!isDrawingMode) return;
  if (drawnPoints.length >= 3) {
    finishDrawing();
  }
}

function finishDrawing() {
  if (drawnPoints.length < 3) return;
  stopDrawingMode();
  
  drawingMarkers.forEach(m => adminMap.removeLayer(m));
  drawingMarkers = [];
  if (drawingPolyline) {
    adminMap.removeLayer(drawingPolyline);
    drawingPolyline = null;
  }
  
  finalPolygon = L.polygon(drawnPoints, {
    color: '#3B7A57',
    fillColor: '#3B7A57',
    fillOpacity: 0.15,
    weight: 3
  }).addTo(adminMap);
  
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
  
  const worldCoords = [
    [-90, -180],
    [-90, 180],
    [90, 180],
    [90, -180]
  ];
  
  adminFincaMaskLayer = L.polygon([worldCoords, drawnPoints], {
    color: '#000000',
    fillColor: '#000000',
    fillOpacity: 0.9,
    stroke: false,
    interactive: false
  }).addTo(adminMap);
  
  adminMap.fitBounds(finalPolygon.getBounds());
  document.getElementById('draw-status-text').textContent = "Linde delimitada.";
  document.getElementById('save-drawn-finca-panel').style.display = 'flex';
  document.getElementById('drawn-finca-coords-text').textContent = `Lat: ${centroid.lat.toFixed(5)}, Lng: ${centroid.lng.toFixed(5)}`;
}

function clearDrawing() {
  drawingMarkers.forEach(m => adminMap.removeLayer(m));
  drawingMarkers = [];
  if (drawingPolyline) {
    adminMap.removeLayer(drawingPolyline);
    drawingPolyline = null;
  }
  if (finalPolygon) {
    adminMap.removeLayer(finalPolygon);
    finalPolygon = null;
  }
  if (adminFincaMaskLayer) {
    adminMap.removeLayer(adminFincaMaskLayer);
    adminFincaMaskLayer = null;
  }
  drawnPoints = [];
  centroid = null;
  document.getElementById('btn-draw-clear').setAttribute('disabled', 'true');
  document.getElementById('save-drawn-finca-panel').style.display = 'none';
  document.getElementById('drawn-finca-name').value = '';
}

function saveDrawnFinca() {
  const name = document.getElementById('drawn-finca-name').value.trim();
  if (!name) {
    alert("Introduce un nombre.");
    return;
  }
  
  const newFinca = {
    id: 'finca-' + Date.now(),
    name: name,
    lat: centroid.lat,
    lng: centroid.lng,
    polygon: [...drawnPoints]
  };
  
  appState.fincas.push(newFinca);
  saveData();
  alert(`Finca "${name}" guardada.`);
  clearDrawing();
  renderApp();
  renderFincasSettingsList();
  
  // Ir a pestaña Configuración
  document.getElementById('tab-btn-config').click();
}

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
      if (importedFinca.name && typeof importedFinca.lat === 'number' && typeof importedFinca.lng === 'number') {
        tempImportedFinca = {
          name: importedFinca.name,
          lat: importedFinca.lat,
          lng: importedFinca.lng,
          polygon: Array.isArray(importedFinca.polygon) ? importedFinca.polygon : []
        };
        fileInfo.textContent = `Cargado: ${file.name} (Centro: ${importedFinca.lat.toFixed(4)}, ${importedFinca.lng.toFixed(4)})`;
        fileInfo.style.color = "var(--primary)";
      } else {
        fileInfo.textContent = "JSON no válido.";
        fileInfo.style.color = "var(--danger)";
        tempImportedFinca = null;
      }
    } catch (err) {
      fileInfo.textContent = "Error al leer JSON.";
      fileInfo.style.color = "var(--danger)";
      tempImportedFinca = null;
    }
  };
  reader.readAsText(file);
}

function handleModalFincaSubmit(e) {
  e.preventDefault();
  const name = document.getElementById('finca-name').value.trim();
  const folderId = document.getElementById('finca-folder-select').value;
  
  if (!tempImportedFinca) {
    alert("Carga un archivo .json válido primero.");
    return;
  }
  
  if (!name) {
    alert("Introduce un nombre.");
    return;
  }
  
  const newFinca = {
    id: 'finca-' + Date.now(),
    name: name,
    lat: tempImportedFinca.lat,
    lng: tempImportedFinca.lng,
    polygon: tempImportedFinca.polygon,
    folderId: folderId
  };
  
  appState.fincas.push(newFinca);
  saveData();
  renderApp();
  renderFincasSettingsList();
  
  document.getElementById('modal-finca').classList.remove('active');
  tempImportedFinca = null;
  alert(`Finca "${name}" creada con éxito.`);
}

// --- GESTIÓN DE CARPETAS ---

// Obtener nombre de una carpeta
function getFolderName(folderId) {
  if (!appState.folders) return 'General';
  const folder = appState.folders.find(f => f.id === folderId);
  return folder ? folder.name : 'General';
}

// Crear nueva carpeta
function createFolder() {
  const input = document.getElementById('input-new-folder');
  const name = input.value.trim();
  if (!name) return;
  
  if (!appState.folders) {
    appState.folders = [{ id: 'general', name: 'General' }];
  }
  
  if (appState.folders.some(f => f.name.toLowerCase() === name.toLowerCase())) {
    alert('Ya existe una carpeta con ese nombre.');
    return;
  }
  
  const id = 'folder-' + Date.now();
  appState.folders.push({ id, name });
  saveData();
  
  input.value = '';
  renderFoldersSettingsList();
  renderApp();
}

// Eliminar carpeta
function deleteFolder(id) {
  if (id === 'general') {
    alert('La carpeta General es del sistema y no se puede eliminar.');
    return;
  }
  
  if (!confirm('¿Estás seguro de eliminar esta carpeta? Las fincas que contiene se moverán a la carpeta General.')) {
    return;
  }
  
  appState.fincas.forEach(finca => {
    if ((finca.folderId || 'general') === id) {
      finca.folderId = 'general';
    }
  });
  
  appState.folders = appState.folders.filter(f => f.id !== id);
  saveData();
  
  renderFoldersSettingsList();
  renderFincasSettingsList();
  renderApp();
}

// Mover finca de carpeta
function moveFincaToFolder(fincaId, folderId) {
  const finca = getFincaById(fincaId);
  if (!finca) return;
  
  finca.folderId = folderId;
  saveData();
  
  renderFincasSettingsList();
  renderApp();
}

// Renderizar listado de carpetas
function renderFoldersSettingsList() {
  const container = document.getElementById('folders-settings-list');
  if (!container) return;
  container.innerHTML = '';
  
  if (!appState.folders) {
    appState.folders = [{ id: 'general', name: 'General' }];
  }
  
  appState.folders.forEach(folder => {
    const item = document.createElement('div');
    item.className = 'folder-settings-item';
    item.style = 'display: flex; justify-content: space-between; align-items: center; border: 1px solid var(--border); padding: 8px 12px; border-radius: var(--radius-sm); background: var(--bg);';
    
    const isGeneral = folder.id === 'general';
    const count = appState.fincas.filter(f => (f.folderId || 'general') === folder.id).length;
    
    item.innerHTML = `
      <span style="font-size: 0.85rem; font-weight: 500; color: var(--text); display: flex; align-items: center; gap: 6px;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:16px; height:16px; color:var(--primary);"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        ${folder.name} <span style="font-size:0.72rem; color:var(--text-muted); font-weight:400;">(${count} fincas)</span>
      </span>
      ${isGeneral ? '' : `
        <button style="background:none; border:none; color:var(--danger); padding:4px; cursor:pointer; display: flex; align-items: center;" onclick="deleteFolder('${folder.id}')" title="Eliminar carpeta">
          <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px; height:14px;"><polyline points="3 6 5 6 21 6"></polyline><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path></svg>
        </button>
      `}
    `;
    container.appendChild(item);
  });
}

// Exponer funciones globales para callbacks inline HTML
window.deleteFolder = deleteFolder;
window.moveFincaToFolder = moveFincaToFolder;


// --- LÓGICA DE LISTA DE LA COMPRA Y ASISTENTE DE VOZ ---

let voiceAssistantActive = false;
let currentVoiceState = 0;
let voiceFlowMode = 'choice'; // 'choice', 'incidencia', 'compra'
let voiceRecognition = null;
let voiceData = {
  fincaId: '',
  isGeneral: true,
  tipo: '',
  herramientas: '',
  materiales: '',
  descripcion: ''
};

// Renderizar la lista de la compra manual y por voz
function renderShoppingList() {
  const container = document.getElementById('compra-list-container');
  if (!container) return;
  container.innerHTML = '';
  
  if (!appState.shoppingList || appState.shoppingList.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:16px 0;">No hay artículos en la lista de la compra.</p>';
    return;
  }
  
  appState.shoppingList.forEach(item => {
    const div = document.createElement('div');
    div.className = `compra-item ${item.checked ? 'checked' : ''}`;
    
    div.innerHTML = `
      <div style="display:flex; align-items:center; gap:10px; flex:1; min-width:0;">
        <input type="checkbox" ${item.checked ? 'checked' : ''} onchange="toggleShoppingItem('${item.id}')" style="width:18px; height:18px; cursor:pointer; accent-color:var(--primary);">
        <span style="font-size:0.9rem; word-break:break-word; font-weight:500;">${item.text}</span>
      </div>
      <button onclick="deleteShoppingItem('${item.id}')" style="background:none; border:none; color:var(--danger); cursor:pointer; padding:4px; display:flex; align-items:center; justify-content:center; font-size:1.4rem; line-height:1;">
        &times;
      </button>
    `;
    container.appendChild(div);
  });
}

// Añadir artículo manualmente
function addManualShoppingItem() {
  const input = document.getElementById('input-new-compra');
  const text = input.value.trim();
  if (!text) return;
  
  if (!appState.shoppingList) appState.shoppingList = [];
  
  // Capitalizar primera letra
  const formattedText = text.charAt(0).toUpperCase() + text.slice(1);
  appState.shoppingList.push({
    id: 'compra-' + Date.now(),
    text: formattedText,
    checked: false
  });
  
  saveData();
  input.value = '';
  renderShoppingList();
}

// Tachar/Destachar artículo manual (ahora completa, elimina y permite deshacer)
function toggleShoppingItem(id) {
  const index = appState.shoppingList.findIndex(i => i.id === id);
  if (index !== -1) {
    // Guardar copia para restaurar
    lastDeletedShoppingItem = appState.shoppingList[index];
    lastDeletedIncidencia = null;
    lastDeletedIncidentSupplyKey = null;
    
    // Eliminar de la lista
    appState.shoppingList.splice(index, 1);
    
    saveData();
    renderShoppingList();
    
    // Mostrar Toast de Deshacer
    const undoToast = document.getElementById('undo-toast');
    undoToast.querySelector('span').textContent = 'Artículo completado';
    undoToast.classList.add('active');
    
    if (undoTimeout) {
      clearTimeout(undoTimeout);
    }
    
    undoTimeout = setTimeout(() => {
      undoToast.classList.remove('active');
      lastDeletedShoppingItem = null;
    }, 3000);
  }
}

// Eliminar artículo manual
function deleteShoppingItem(id) {
  appState.shoppingList = appState.shoppingList.filter(i => i.id !== id);
  saveData();
  renderShoppingList();
}

// Dictado por voz de artículos (añadir varios de golpe)
function startQuickVoiceShopping() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Reconocimiento de voz no soportado en este dispositivo.");
    return;
  }
  
  const statusDiv = document.getElementById('compra-voice-status');
  statusDiv.style.display = 'flex';
  
  const recognition = new SpeechRecognition();
  recognition.lang = 'es-ES';
  recognition.interimResults = false;
  
  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim();
    statusDiv.style.display = 'none';
    
    // Dividir por la conjunción " y " o comas para añadir múltiples a la vez
    const items = transcript.split(/ y |,/i);
    
    if (!appState.shoppingList) appState.shoppingList = [];
    
    items.forEach(it => {
      const text = it.trim();
      if (text) {
        const formattedText = text.charAt(0).toUpperCase() + text.slice(1);
        appState.shoppingList.push({
          id: 'compra-' + Date.now() + '-' + Math.random().toString(36).substr(2, 4),
          text: formattedText,
          checked: false
        });
      }
    });
    
    saveData();
    renderShoppingList();
  };
  
  recognition.onerror = (e) => {
    console.error("Error dictado compra:", e);
    statusDiv.style.display = 'none';
    alert("No he podido entender el dictado. Inténtalo de nuevo.");
  };
  
  recognition.onend = () => {
    statusDiv.style.display = 'none';
  };
  
  recognition.start();
}

// Renderizar la lista de materiales y herramientas requeridos automáticamente por las incidencias
function renderIncidentSuppliesChecklist() {
  const container = document.getElementById('incidencias-compra-list-container');
  if (!container) return;
  container.innerHTML = '';
  
  // Buscar incidencias con materiales o herramientas
  const validIncidencias = appState.incidencias.filter(inc => inc.materiales || inc.herramientas);
  
  if (validIncidencias.length === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:16px 0;">No hay herramientas ni materiales de incidencias pendientes.</p>';
    return;
  }
  
  // Agrupar por finca
  const grouped = {};
  validIncidencias.forEach(inc => {
    if (!grouped[inc.fincaId]) {
      grouped[inc.fincaId] = [];
    }
    grouped[inc.fincaId].push(inc);
  });
  
  let totalVisibleGroups = 0;
  
  // Renderizar agrupados
  for (const fincaId in grouped) {
    const finca = getFincaById(fincaId);
    const fincaName = finca ? finca.name : 'Finca Desconocida';
    
    const groupDiv = document.createElement('div');
    groupDiv.style = 'border: 1px solid var(--border); border-radius: var(--radius-sm); background: var(--bg); padding: 12px; display: flex; flex-direction: column; gap: 8px;';
    
    groupDiv.innerHTML = `
      <h4 style="font-size:0.85rem; font-weight:700; color:var(--primary); border-bottom: 1px solid var(--border); padding-bottom: 6px; margin: 0 0 4px 0; display:flex; align-items:center; gap:6px;">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:14px; height:14px; color:var(--primary);"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg>
        ${fincaName}
      </h4>
      <div class="finca-supplies-items" style="display:flex; flex-direction:column; gap:6px;"></div>
    `;
    
    const itemsContainer = groupDiv.querySelector('.finca-supplies-items');
    let hasVisibleItems = false;
    
    grouped[fincaId].forEach(inc => {
      // Combinar campos por compatibilidad
      const combined = [inc.materiales, inc.herramientas].filter(Boolean).join(', ');
      if (combined) {
        const items = combined.split(/,| y /i);
        items.forEach((item, idx) => {
          const text = item.trim();
          if (!text) return;
          const key = `${inc.id}-supply-${idx}`;
          const isChecked = appState.checkedIncidentSupplies && appState.checkedIncidentSupplies.includes(key);
          if (!isChecked) {
            renderSupplyRow(itemsContainer, key, `🛠️ ${text} (Inc: ${inc.tipo})`);
            hasVisibleItems = true;
          }
        });
      }
    });
    
    if (hasVisibleItems) {
      container.appendChild(groupDiv);
      totalVisibleGroups++;
    }
  }
  
  if (totalVisibleGroups === 0) {
    container.innerHTML = '<p style="text-align:center; color:var(--text-muted); font-size:0.85rem; padding:16px 0;">No hay herramientas ni materiales de incidencias pendientes.</p>';
  }
}

function renderSupplyRow(container, key, text) {
  const row = document.createElement('div');
  row.className = 'compra-item';
  row.style = 'padding: 8px 10px; font-size: 0.8rem; background: var(--card-bg);';
  
  row.innerHTML = `
    <div style="display:flex; align-items:center; gap:8px; flex:1; min-width:0;">
      <input type="checkbox" onchange="toggleIncidentSupply('${key}')" style="width:16px; height:16px; cursor:pointer; accent-color:var(--primary);">
      <span style="word-break:break-word; font-weight:500;">${text}</span>
    </div>
  `;
  container.appendChild(row);
}

// Ocultar suministro de incidencia auto-compilado y permitir deshacer
function toggleIncidentSupply(key) {
  if (!appState.checkedIncidentSupplies) appState.checkedIncidentSupplies = [];
  
  const index = appState.checkedIncidentSupplies.indexOf(key);
  if (index === -1) {
    appState.checkedIncidentSupplies.push(key);
    lastDeletedIncidentSupplyKey = key;
    lastDeletedIncidencia = null;
    lastDeletedShoppingItem = null;
    
    saveData();
    renderIncidentSuppliesChecklist();
    
    // Mostrar Toast de Deshacer
    const undoToast = document.getElementById('undo-toast');
    undoToast.querySelector('span').textContent = 'Suministro completado';
    undoToast.classList.add('active');
    
    if (undoTimeout) {
      clearTimeout(undoTimeout);
    }
    
    undoTimeout = setTimeout(() => {
      undoToast.classList.remove('active');
      lastDeletedIncidentSupplyKey = null;
    }, 3000);
  }
}

// --- ASISTENTE DE VOZ INTERACTIVO (MANOS LIBRES) ---

// Hablar por altavoz (TTS)
function speak(text, onEndCallback) {
  if (!window.speechSynthesis) {
    if (onEndCallback) onEndCallback();
    return;
  }
  window.speechSynthesis.cancel();
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = 'es-ES';
  
  let callbackFired = false;
  const triggerCallback = () => {
    if (callbackFired) return;
    callbackFired = true;
    if (voiceAssistantActive && onEndCallback) {
      onEndCallback();
    }
  };
  
  utterance.onend = triggerCallback;
  utterance.onerror = triggerCallback;
  window.speechSynthesis.speak(utterance);
}

// Escuchar respuesta (STT)
function listen(onResultCallback, onErrorCallback) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    alert("Reconocimiento de voz no soportado en este navegador.");
    stopVoiceAssistant();
    return;
  }
  
  if (voiceRecognition) {
    try {
      voiceRecognition.onend = null;
      voiceRecognition.onerror = null;
      voiceRecognition.onresult = null;
      voiceRecognition.stop();
    } catch(e){}
  }
  
  voiceRecognition = new SpeechRecognition();
  voiceRecognition.lang = 'es-ES';
  voiceRecognition.interimResults = false;
  voiceRecognition.maxAlternatives = 1;
  
  document.getElementById('voice-transcript-text').textContent = "Escuchando...";
  document.getElementById('voice-transcript-text').style.color = "var(--primary-light)";
  
  let callbackFired = false;
  
  voiceRecognition.onresult = (event) => {
    if (callbackFired) return;
    callbackFired = true;
    const transcript = event.results[0][0].transcript.trim();
    document.getElementById('voice-transcript-text').textContent = `Entendido: "${transcript}"`;
    document.getElementById('voice-transcript-text').style.color = "#a3ffa3";
    
    setTimeout(() => {
      if (voiceAssistantActive && onResultCallback) {
        onResultCallback(transcript);
      }
    }, 1000);
  };
  
  voiceRecognition.onerror = (event) => {
    if (callbackFired) return;
    callbackFired = true;
    console.error("Error reconocimiento:", event.error);
    document.getElementById('voice-transcript-text').textContent = "No te he escuchado bien. Reintentando...";
    document.getElementById('voice-transcript-text').style.color = "var(--danger)";
    
    setTimeout(() => {
      if (voiceAssistantActive && onErrorCallback) {
        onErrorCallback();
      }
    }, 1500);
  };
  
  try {
    voiceRecognition.start();
  } catch(e) {
    console.error(e);
    if (!callbackFired && onErrorCallback) {
      callbackFired = true;
      onErrorCallback();
    }
  }
}

// Buscar finca por nombre (Fuzzy match e insensibilidad a acentos)
function findFincaIdByName(name) {
  if (!name) return null;
  const cleanInput = name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
  
  let bestMatch = null;
  appState.fincas.forEach(f => {
    const cleanFincaName = f.name.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "").trim();
    if (cleanFincaName === cleanInput || cleanFincaName.includes(cleanInput) || cleanInput.includes(cleanFincaName)) {
      bestMatch = f.id;
    }
  });
  return bestMatch;
}

// Iniciar Asistente de voz
function startVoiceAssistant() {
  voiceAssistantActive = true;
  voiceFlowMode = 'choice';
  currentVoiceState = 0;
  voiceData = {
    fincaId: '',
    isGeneral: true,
    tipo: '',
    herramientas: '',
    materiales: '',
    descripcion: ''
  };
  
  document.getElementById('voice-assistant-overlay').classList.add('active');
  runVoiceAssistantStep();
}

// Detener asistente
function stopVoiceAssistant() {
  voiceAssistantActive = false;
  if (voiceRecognition) {
    try {
      voiceRecognition.onend = null;
      voiceRecognition.stop();
    } catch(e){}
  }
  if (window.speechSynthesis) {
    window.speechSynthesis.cancel();
  }
  document.getElementById('voice-assistant-overlay').classList.remove('active');
}

// Máquina de estados del asistente
function runVoiceAssistantStep() {
  if (!voiceAssistantActive) return;
  
  const stepIndicator = document.getElementById('voice-step-indicator');
  const promptText = document.getElementById('voice-prompt-text');
  
  // MENU PRINCIPAL DE ELECCIÓN
  if (voiceFlowMode === 'choice') {
    stepIndicator.textContent = "Menú Principal";
    promptText.textContent = "¿Qué deseas hacer? ¿Reportar una incidencia o añadir algo a la lista de la compra?";
    
    speak("¿Qué deseas hacer? ¿Reportar una incidencia o añadir algo a la lista de la compra?", () => {
      listen((result) => {
        const text = result.toLowerCase();
        if (text.includes("incidencia") || text.includes("incidente") || text.includes("reportar") || text.includes("averia") || text.includes("avería") || text.includes("problema")) {
          voiceFlowMode = 'incidencia';
          currentVoiceState = 0;
          speak("Entendido. Vamos a registrar la incidencia.", () => {
            runVoiceAssistantStep();
          });
        } else if (text.includes("compra") || text.includes("lista") || text.includes("añadir") || text.includes("articulo") || text.includes("artículo") || text.includes("producto")) {
          voiceFlowMode = 'compra';
          currentVoiceState = 0;
          speak("Entendido. Vamos a añadir a la lista de la compra.", () => {
            runVoiceAssistantStep();
          });
        } else {
          speak("Por favor, di reportar incidencia o lista de la compra.", () => {
            listen((retryResult) => {
              const retryText = retryResult.toLowerCase();
              if (retryText.includes("incidencia") || retryText.includes("reportar") || retryText.includes("averia")) {
                voiceFlowMode = 'incidencia';
                currentVoiceState = 0;
                runVoiceAssistantStep();
              } else if (retryText.includes("compra") || retryText.includes("lista") || retryText.includes("añadir")) {
                voiceFlowMode = 'compra';
                currentVoiceState = 0;
                runVoiceAssistantStep();
              } else {
                speak("No te he entendido. Cerrando el asistente.", () => {
                  stopVoiceAssistant();
                });
              }
            }, () => {
              stopVoiceAssistant();
            });
          });
        }
      }, () => {
        speak("No te he escuchado. ¿Quieres registrar una incidencia o añadir a la lista de la compra?", () => {
          listen((retryResult) => {
            const retryText = retryResult.toLowerCase();
            if (retryText.includes("incidencia") || retryText.includes("reportar")) {
              voiceFlowMode = 'incidencia';
              currentVoiceState = 0;
              runVoiceAssistantStep();
            } else if (retryText.includes("compra") || retryText.includes("lista")) {
              voiceFlowMode = 'compra';
              currentVoiceState = 0;
              runVoiceAssistantStep();
            } else {
              stopVoiceAssistant();
            }
          }, () => {
            stopVoiceAssistant();
          });
        });
      });
    });
    return;
  }
  
  // SUBFLUJO 1: AÑADIR A LA LISTA DE LA COMPRA
  if (voiceFlowMode === 'compra') {
    stepIndicator.textContent = "Compra: Paso 1 de 1";
    promptText.textContent = "¿Qué artículos quieres añadir a la lista de la compra?";
    
    speak("¿Qué artículos quieres añadir a la lista de la compra?", () => {
      listen((result) => {
        const cleanResult = result.trim();
        const lowerResult = cleanResult.toLowerCase();
        if (lowerResult === "ninguno" || lowerResult === "nada" || lowerResult === "no") {
          speak("Entendido. Proceso finalizado sin añadir artículos.", () => {
            stopVoiceAssistant();
          });
          return;
        }
        
        const items = cleanResult.split(/ y |,/i);
        if (!appState.shoppingList) appState.shoppingList = [];
        
        items.forEach((it, idx) => {
          const text = it.trim();
          if (text) {
            const formatted = text.charAt(0).toUpperCase() + text.slice(1);
            appState.shoppingList.push({
              id: 'compra-' + Date.now() + '-' + idx,
              text: formatted,
              checked: false
            });
          }
        });
        
        saveData();
        
        speak("Artículos añadidos a la lista de la compra. Proceso finalizado.", () => {
          stopVoiceAssistant();
          // Navegar a la sección de compras
          document.getElementById('nav-btn-compra').click();
          document.getElementById('tab-compra-manual').click();
          renderShoppingList();
        });
      }, () => {
        speak("No te he escuchado bien. Cerrando el asistente.", () => {
          stopVoiceAssistant();
        });
      });
    });
    return;
  }
  
  // SUBFLUJO 2: REGISTRAR INCIDENCIA
  switch(currentVoiceState) {
    case 0:
      stepIndicator.textContent = "Incidencia: Paso 1 de 5: Finca";
      promptText.textContent = "¿En qué finca quieres registrar la incidencia?";
      speak("¿En qué finca quieres registrar la incidencia?", () => {
        listen((result) => {
          const matchedId = findFincaIdByName(result);
          if (matchedId) {
            voiceData.fincaId = matchedId;
            const finca = getFincaById(matchedId);
            speak(`Finca ${finca.name} seleccionada.`, () => {
              currentVoiceState = 1;
              runVoiceAssistantStep();
            });
          } else {
            speak("No he encontrado esa finca. Di de nuevo el nombre.", () => {
              listen((retryResult) => {
                const matchedIdRetry = findFincaIdByName(retryResult);
                if (matchedIdRetry) {
                  voiceData.fincaId = matchedIdRetry;
                  const finca = getFincaById(matchedIdRetry);
                  speak(`Finca ${finca.name} seleccionada.`, () => {
                    currentVoiceState = 1;
                    runVoiceAssistantStep();
                  });
                } else {
                  voiceData.fincaId = appState.selectedFincaId || (appState.fincas[0] ? appState.fincas[0].id : 'general');
                  const finca = getFincaById(voiceData.fincaId);
                  speak(`Asociando a la finca activa, ${finca ? finca.name : 'General'}.`, () => {
                    currentVoiceState = 1;
                    runVoiceAssistantStep();
                  });
                }
              }, () => {
                voiceData.fincaId = appState.selectedFincaId || (appState.fincas[0] ? appState.fincas[0].id : 'general');
                currentVoiceState = 1;
                runVoiceAssistantStep();
              });
            });
          }
        }, () => {
          speak("No te he oído. ¿Cuál es el nombre de la finca?", () => {
            listen((retryResult) => {
              const matchedIdRetry = findFincaIdByName(retryResult);
              if (matchedIdRetry) {
                voiceData.fincaId = matchedIdRetry;
                currentVoiceState = 1;
                runVoiceAssistantStep();
              } else {
                voiceData.fincaId = appState.selectedFincaId || (appState.fincas[0] ? appState.fincas[0].id : 'general');
                currentVoiceState = 1;
                runVoiceAssistantStep();
              }
            }, () => {
              voiceData.fincaId = appState.selectedFincaId || (appState.fincas[0] ? appState.fincas[0].id : 'general');
              currentVoiceState = 1;
              runVoiceAssistantStep();
            });
          });
        });
      });
      break;
      
    case 1:
      stepIndicator.textContent = "Incidencia: Paso 2 de 5: Ubicación";
      promptText.textContent = "¿Quieres registrar una incidencia general o en tu ubicación actual?";
      speak("¿Quieres registrar una incidencia general o en tu ubicación actual?", () => {
        listen((result) => {
          const text = result.toLowerCase();
          if (text.includes("general") || text.includes("primera") || text.includes("finca")) {
            voiceData.isGeneral = true;
            speak("Ubicación general seleccionada.", () => {
              currentVoiceState = 2;
              runVoiceAssistantStep();
            });
          } else if (text.includes("actual") || text.includes("ubicacion") || text.includes("segunda") || text.includes("gps")) {
            voiceData.isGeneral = false;
            speak("Ubicación actual seleccionada.", () => {
              currentVoiceState = 2;
              runVoiceAssistantStep();
            });
          } else {
            speak("Di general o ubicación actual.", () => {
              listen((retryResult) => {
                const textRetry = retryResult.toLowerCase();
                if (textRetry.includes("actual") || textRetry.includes("ubicacion")) {
                  voiceData.isGeneral = false;
                } else {
                  voiceData.isGeneral = true;
                }
                speak(voiceData.isGeneral ? "Establecido como general." : "Establecido en ubicación actual.", () => {
                  currentVoiceState = 2;
                  runVoiceAssistantStep();
                });
              }, () => {
                voiceData.isGeneral = true;
                currentVoiceState = 2;
                runVoiceAssistantStep();
              });
            });
          }
        }, () => {
          voiceData.isGeneral = true;
          currentVoiceState = 2;
          runVoiceAssistantStep();
        });
      });
      break;
      
    case 2:
      stepIndicator.textContent = "Incidencia: Paso 3 de 5: Incidencia";
      promptText.textContent = "¿Cuál es el tipo de incidencia?";
      speak("¿Cuál es el tipo de incidencia?", () => {
        listen((result) => {
          if (result) {
            voiceData.tipo = result;
            speak(`Entendido: ${result}.`, () => {
              currentVoiceState = 3;
              runVoiceAssistantStep();
            });
          } else {
            speak("Di qué incidencia es.", () => {
              listen((retryResult) => {
                voiceData.tipo = retryResult || "Incidencia sin tipo";
                currentVoiceState = 3;
                runVoiceAssistantStep();
              });
            });
          }
        }, () => {
          speak("No te he escuchado. ¿De qué es la incidencia?", () => {
            listen((retryResult) => {
              voiceData.tipo = retryResult || "Incidencia sin tipo";
              currentVoiceState = 3;
              runVoiceAssistantStep();
            }, () => {
              voiceData.tipo = "Incidencia sin tipo";
              currentVoiceState = 3;
              runVoiceAssistantStep();
            });
          });
        });
      });
      break;
      
    case 3:
      stepIndicator.textContent = "Incidencia: Paso 4 de 5: Materiales y Herramientas";
      promptText.textContent = "¿Qué materiales y herramientas necesitas? Di ninguno si no necesitas nada.";
      speak("¿Qué materiales y herramientas necesitas? Di ninguno si no necesitas nada.", () => {
        listen((result) => {
          const clean = result.toLowerCase().trim();
          if (clean === "ninguno" || clean === "ninguna" || clean === "no" || clean === "nada") {
            voiceData.materiales = "";
            speak("Sin materiales ni herramientas.", () => {
              currentVoiceState = 4;
              runVoiceAssistantStep();
            });
          } else {
            voiceData.materiales = result;
            speak(`Añadido: ${result}.`, () => {
              currentVoiceState = 4;
              runVoiceAssistantStep();
            });
          }
        }, () => {
          voiceData.materiales = "";
          currentVoiceState = 4;
          runVoiceAssistantStep();
        });
      });
      break;
      
    case 4:
      stepIndicator.textContent = "Incidencia: Paso 5 de 5: Notas Adicionales";
      promptText.textContent = "¿Quieres añadir alguna nota o descripción? Di no para terminar.";
      speak("¿Quieres añadir alguna nota o descripción? Di no para terminar.", () => {
        listen((result) => {
          const clean = result.toLowerCase().trim();
          if (clean === "no" || clean === "ninguna" || clean === "ninguno" || clean === "terminar") {
            voiceData.descripcion = "";
          } else {
            voiceData.descripcion = result;
          }
          speak("Guardando incidencia.", () => {
            saveVoiceIncident();
          });
        }, () => {
          voiceData.descripcion = "";
          saveVoiceIncident();
        });
      });
      break;
  }
}

function saveVoiceIncident() {
  let lat = null;
  let lng = null;
  
  if (!voiceData.isGeneral) {
    if (lastGpsPosition) {
      lat = lastGpsPosition.lat;
      lng = lastGpsPosition.lng;
    } else {
      const finca = getFincaById(voiceData.fincaId);
      if (finca) {
        lat = finca.lat;
        lng = finca.lng;
      }
    }
  }
  
  const newInc = {
    id: 'inc-' + Date.now(),
    fincaId: voiceData.fincaId,
    tipo: voiceData.tipo || "Incidencia de Voz",
    descripcion: voiceData.descripcion || "",
    materiales: voiceData.materiales || "",
    herramientas: '', // Campo unificado
    lat: lat,
    lng: lng,
    estado: 'Pendiente',
    fecha: new Date().toISOString()
  };
  
  appState.incidencias.push(newInc);
  saveData();
  
  speak("Incidencia guardada con éxito. Proceso finalizado.", () => {
    stopVoiceAssistant();
    renderApp();
    renderIncidenciasList();
  });
}

// Exponer funciones globales para callbacks inline HTML
window.deleteFolder = deleteFolder;
window.moveFincaToFolder = moveFincaToFolder;
window.toggleShoppingItem = toggleShoppingItem;
window.deleteShoppingItem = deleteShoppingItem;
window.toggleIncidentSupply = toggleIncidentSupply;


// --- FUNCIONES DE SINCRONIZACIÓN EN LA NUBE ---

// Obtener URL de la función serverless de Netlify para evitar CORS preflight
function getCloudSyncUrl(code = '') {
  const isLocal = window.location.hostname === 'localhost' || 
                  window.location.hostname === '127.0.0.1' || 
                  window.location.hostname.startsWith('192.168.') || 
                  window.location.hostname.startsWith('172.20.') ||
                  window.location.hostname.startsWith('10.');
  const base = isLocal ? 'https://fincasaldia.com' : '';
  return `${base}/.netlify/functions/sync${code ? '?code=' + code : ''}`;
}

function updateCloudSyncUI() {
  const setupBox = document.getElementById('sync-setup-box');
  const activeBox = document.getElementById('sync-active-box');
  
  if (!setupBox || !activeBox) return;
  
  if (appState.syncCode) {
    setupBox.style.display = 'none';
    activeBox.style.display = 'flex';
    document.getElementById('text-active-sync-code').textContent = appState.syncCode;
  } else {
    setupBox.style.display = 'flex';
    activeBox.style.display = 'none';
  }
}

function generateCloudSyncGroup() {
  const btn = document.getElementById('btn-generate-sync-code');
  btn.disabled = true;
  btn.textContent = "Generando grupo...";
  
  fetch(getCloudSyncUrl(), {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: JSON.stringify(appState)
  })
  .then(res => {
    if (!res.ok) {
      return res.text().then(text => {
        throw new Error(`Servidor respondió con código ${res.status}: ${text || 'Sin detalle'}`);
      });
    }
    return res.json();
  })
  .then(resData => {
    if (resData && resData.id) {
      appState.syncCode = resData.id;
      saveData();
      updateCloudSyncUI();
      alert("¡Grupo de sincronización creado con éxito! Copia el código y úsalo en los otros dispositivos.");
    } else {
      throw new Error("El servidor no devolvió un identificador de grupo (ID).");
    }
  })
  .catch(err => {
    console.error(err);
    alert("Error de conexión al crear el grupo:\n" + err.message);
  })
  .finally(() => {
    btn.disabled = false;
    btn.textContent = "Crear Nuevo Grupo de Sincronización";
  });
}

function connectToCloudSyncGroup() {
  const input = document.getElementById('input-sync-code');
  const code = input.value.trim().toLowerCase();
  if (!code) {
    alert("Introduce un código de sincronización válido.");
    return;
  }
  
  const btn = document.getElementById('btn-connect-sync-code');
  btn.disabled = true;
  btn.textContent = "Cargando...";
  
  fetch(getCloudSyncUrl(code))
  .then(res => {
    if (!res.ok) throw new Error("Bin not found");
    return res.json();
  })
  .then(cloudData => {
    if (cloudData && cloudData.fincas) {
      if (confirm("Se han descargado los datos de la nube con éxito. ¿Quieres sobreescribir tus datos locales con los del grupo?")) {
        appState = cloudData;
        appState.syncCode = code;
        
        sanitizeData();
        
        saveData();
        renderApp();
        renderFincasSettingsList();
        renderFoldersSettingsList();
        updateCloudSyncUI();
        
        // Centrar el mapa en la finca activa conectada
        const initialFinca = getFincaById(appState.selectedFincaId);
        if (initialFinca && map) {
          map.setView([initialFinca.lat, initialFinca.lng], 16);
          restrictMapBounds(initialFinca);
        }
        
        alert("¡Conectado y sincronizado con éxito!");
      }
    } else {
      alert("Los datos de este código no tienen un formato compatible.");
    }
  })
  .catch(err => {
    console.error(err);
    alert("No se ha encontrado ningún grupo con ese código o no hay conexión.");
  })
  .finally(() => {
    btn.disabled = false;
    btn.textContent = "Conectar";
  });
}

function forceCloudSync() {
  const btn = document.getElementById('btn-force-sync');
  const status = document.getElementById('sync-status-msg');
  if (!appState.syncCode) return;
  
  btn.disabled = true;
  btn.textContent = "Sincronizando...";
  status.textContent = "Descargando actualizaciones...";
  status.style.color = "var(--primary)";
  
  // 1. Descargar la versión más reciente de la nube
  fetch(getCloudSyncUrl(appState.syncCode))
  .then(res => {
    if (!res.ok) throw new Error("Fetch failed");
    return res.json();
  })
  .then(cloudData => {
    // 2. Mezclar datos: para evitar conflictos complejos, unificamos la lista de la compra, incidencias y fincas
    const code = appState.syncCode;
    
    // Si la nube tiene fincas, la adoptamos, pero si en local tenemos algo nuevo, unificamos por ID
    const mergedFincas = [...appState.fincas];
    if (cloudData.fincas) {
      cloudData.fincas.forEach(cf => {
        if (!mergedFincas.some(lf => lf.id === cf.id)) {
          mergedFincas.push(cf);
        }
      });
    }
    
    const mergedIncidencias = [...appState.incidencias];
    if (cloudData.incidencias) {
      cloudData.incidencias.forEach(ci => {
        if (!mergedIncidencias.some(li => li.id === ci.id)) {
          mergedIncidencias.push(ci);
        }
      });
    }
    
    const mergedShopping = [...(appState.shoppingList || [])];
    if (cloudData.shoppingList) {
      cloudData.shoppingList.forEach(cs => {
        if (!mergedShopping.some(ls => ls.id === cs.id)) {
          mergedShopping.push(cs);
        }
      });
    }
    
    const mergedCheckedSupplies = [...(appState.checkedIncidentSupplies || [])];
    if (cloudData.checkedIncidentSupplies) {
      cloudData.checkedIncidentSupplies.forEach(ck => {
        if (!mergedCheckedSupplies.includes(ck)) {
          mergedCheckedSupplies.push(ck);
        }
      });
    }
    
    const mergedFolders = [...(appState.folders || [])];
    if (cloudData.folders) {
      cloudData.folders.forEach(cf => {
        if (!mergedFolders.some(lf => lf.id === cf.id)) {
          mergedFolders.push(cf);
        }
      });
    }
    
    appState.fincas = mergedFincas;
    appState.incidencias = mergedIncidencias;
    appState.shoppingList = mergedShopping;
    appState.checkedIncidentSupplies = mergedCheckedSupplies;
    appState.folders = mergedFolders;
    
    sanitizeData();
    
    status.textContent = "Subiendo datos mezclados...";
    
    // 3. Subir el resultado de la mezcla de vuelta a la nube
    return fetch(getCloudSyncUrl(code), {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify(appState)
    });
  })
  .then(res => {
    if (!res.ok) throw new Error("Upload failed");
    saveData();
    renderApp();
    renderFincasSettingsList();
    renderFoldersSettingsList();
    
    status.textContent = "¡Sincronizado con éxito!";
    status.style.color = "var(--primary)";
    setTimeout(() => {
      status.textContent = "Sincronizado local y en la nube.";
    }, 3000);
  })
  .catch(err => {
    console.error(err);
    status.textContent = "Error al sincronizar. Revisa la conexión.";
    status.style.color = "var(--danger)";
  })
  .finally(() => {
    btn.disabled = false;
    btn.textContent = "Forzar Sincronización";
  });
}

function disconnectCloudSync() {
  if (confirm("¿Seguro que deseas desconectar este dispositivo de la nube? Conservarás tus datos actuales en local, pero los cambios que hagas ya no se compartirán.")) {
    delete appState.syncCode;
    saveData();
    updateCloudSyncUI();
    alert("Dispositivo desconectado de la nube.");
  }
}

// Pantalla completa interactiva gigante para activar el micrófono saltando políticas de seguridad
function showGiantStartTarget() {
  const overlay = document.createElement('div');
  overlay.id = 'giant-voice-trigger-overlay';
  overlay.style = `
    position: fixed;
    top: 0;
    left: 0;
    width: 100vw;
    height: 100vh;
    background: radial-gradient(circle at center, #2e4536, #16241b);
    z-index: 100000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    color: #fff;
    font-family: 'Outfit', sans-serif;
    text-align: center;
    padding: 24px;
    cursor: pointer;
    box-sizing: border-box;
  `;
  
  overlay.innerHTML = `
    <div class="voice-assistant-wave animate" style="margin-bottom: 24px; width: 100px; height: 100px; background: rgba(255,255,255,0.1); border-radius: 50%; display: flex; align-items: center; justify-content: center; border: 2px dashed rgba(255,255,255,0.3); animation: pulse 2s infinite;">
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:40px; height:40px; color:#a3ffa3;"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
    </div>
    <h2 style="font-size: 1.6rem; font-weight: 700; margin: 0 0 12px 0; color: #a3ffa3;">Asistente Manos Libres</h2>
    <p style="font-size: 1.05rem; line-height: 1.4; color: #d0ded4; max-width: 320px; margin: 0;">Toca en cualquier parte de la pantalla para empezar a dictar.</p>
  `;
  
  overlay.addEventListener('click', () => {
    overlay.remove();
    // Limpiar el parámetro de la URL discretamente para que no reinicie en bucle
    window.history.replaceState({}, document.title, window.location.pathname);
    startVoiceAssistant();
  });
  
  document.body.appendChild(overlay);
}

// Sincronización silenciosa automática en segundo plano
function backgroundCloudSync() {
  if (!appState.syncCode) return;
  
  fetch(getCloudSyncUrl(appState.syncCode))
  .then(res => {
    if (!res.ok) throw new Error("Fetch failed");
    return res.json();
  })
  .then(cloudData => {
    if (!cloudData || !cloudData.fincas) return;
    
    const localTime = appState.lastUpdated || 0;
    const cloudTime = cloudData.lastUpdated || 0;
    
    if (cloudTime > localTime) {
      const code = appState.syncCode;
      appState = cloudData;
      appState.syncCode = code;
      
      sanitizeData();
      
      // Guardar localmente
      localStorage.setItem('fh_fincas', JSON.stringify(appState.fincas));
      localStorage.setItem('fh_incidencias', JSON.stringify(appState.incidencias));
      localStorage.setItem('fh_folders', JSON.stringify(appState.folders));
      localStorage.setItem('fh_shopping_list', JSON.stringify(appState.shoppingList || []));
      localStorage.setItem('fh_checked_supplies', JSON.stringify(appState.checkedIncidentSupplies || []));
      localStorage.setItem('fh_sync_code', appState.syncCode);
      localStorage.setItem('fh_last_updated', String(appState.lastUpdated || 0));
      
      // Re-renderizar la pantalla de forma silenciosa
      renderApp();
      renderFincasSettingsList();
      renderFoldersSettingsList();
      renderShoppingList();
      renderIncidentSuppliesChecklist();
      if (map) {
        updateMapMarkers();
      }
      console.log("Datos locales actualizados desde la nube (LWW).");
    } else if (localTime > cloudTime) {
      // El local es más nuevo: subir a la nube sin cambiar el timestamp local
      saveData(false);
      console.log("Datos de la nube actualizados desde local (LWW).");
    }
  })
  .catch(err => console.error("Background sync error:", err));
}

