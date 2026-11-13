/* Salud en Casa — utilidades compartidas por todas las pantallas
   - Avisos dentro de la pantalla (reemplazan las ventanitas del navegador, que muchos celulares bloquean)
   - Confirmaciones dentro de la pantalla: confirmar('¿Seguro?') devuelve una promesa true/false
   - Botón flotante de WhatsApp directo a la IPS
   - Crédito de SkyNet Genesis
   Uso: <script src="comun.js" data-rol="paciente|profesional|admin|publico"></script> */
(function () {
  var IPS_WHATSAPP = '573128886611';
  var IPS_NOMBRE = 'Clínica Reina Elizabeth IPS';
  var script = document.currentScript;
  var ROL = (script && script.getAttribute('data-rol')) || 'publico';

  var css = '' +
    /* Avisos grandes, azules, legibles y que duran (directiva de todas las apps); se cierran tocándolos */
    '.sec-toast-zona{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:10001;display:flex;flex-direction:column;gap:10px;width:calc(100% - 28px);max-width:480px;pointer-events:none}' +
    'body:has(.sec-modal-fondo) .sec-toast-zona,body:has(#cal-overlay) .sec-toast-zona{top:auto;bottom:18px}' +
    '.sec-toast{pointer-events:auto;cursor:pointer;display:flex;gap:12px;align-items:flex-start;background:#0B4F8A;color:#FFFFFF;border-radius:14px;padding:16px 18px;font:600 17px/1.45 "Public Sans",system-ui,sans-serif;box-shadow:0 10px 30px rgba(11,79,138,.35);opacity:0;transform:translateY(-10px);transition:all .25s}' +
    '.sec-toast .ic{font-size:20px;line-height:1.2;flex:none}' +
    '.sec-toast .x{margin-left:auto;font-size:22px;line-height:1;opacity:.85;flex:none}' +
    '.sec-toast.ver{opacity:1;transform:none}.sec-toast.error{background:#B4412F;box-shadow:0 10px 30px rgba(180,65,47,.35)}.sec-toast.aviso{background:#0E8571;box-shadow:0 10px 30px rgba(14,133,113,.35)}' +
    /* Casillas, selectores y fechas siempre claros (nunca fondo negro) */
    '[hidden]{display:none!important}' +
    'input[type=checkbox],input[type=radio]{accent-color:#14A38B;color-scheme:light;background:#FFFFFF;width:20px;height:20px;flex:none}' +
    'input[type=date],input[type=time],input[type=datetime-local],select{color-scheme:light;background-color:#FFFFFF;color:#1C2B39}' +
    /* Ver u ocultar la contraseña */
    '.sec-clave{position:relative;display:block}.sec-clave input{padding-right:92px!important;width:100%;box-sizing:border-box}' +
    '.sec-ojo{position:absolute;right:8px;top:50%;transform:translateY(-50%);border:1px solid #DCE5EE;background:#FFFFFF;color:#0B4F8A;border-radius:8px;padding:6px 10px;font:700 13px "Public Sans",sans-serif;cursor:pointer}' +
    /* Botón volver con texto, bien visible; y nota que explica de dónde salen los datos */
    '.sec-volver{display:inline-flex;align-items:center;gap:6px;background:#FFFFFF;color:#0B4F8A;border:1.5px solid #DCE5EE;border-radius:10px;padding:10px 14px;font:700 15px "Public Sans",sans-serif;cursor:pointer;text-decoration:none}' +
    '.sec-origen{font:500 13px/1.45 "Public Sans",sans-serif;color:#33475B;background:#E8F1FA;border-radius:10px;padding:10px 12px;margin:0 0 12px}' +
    '.sec-modal-fondo{position:fixed;inset:0;background:rgba(28,43,57,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px;overflow-y:auto}' +
    '@media (max-height:640px){.sec-modal-fondo{align-items:flex-start}}' +
    '.sec-modal{background:#FFFFFF;color:#1C2B39;border-radius:14px;padding:22px 20px;width:100%;max-width:380px;font:400 15px/1.5 "Public Sans",system-ui,sans-serif;box-shadow:0 12px 40px rgba(28,43,57,.3)}' +
    '.sec-modal h3{margin:0 0 8px;font:700 22px "Barlow Condensed",sans-serif;color:#0B4F8A}' +
    '.sec-modal p{margin:0 0 18px;white-space:pre-line}' +
    '.sec-modal-botones{display:flex;gap:10px}.sec-modal-botones button{flex:1;padding:12px;border-radius:10px;border:0;font:700 15px "Public Sans",sans-serif;cursor:pointer}' +
    '.sec-btn-no{background:#F4F8FB;color:#1C2B39}.sec-btn-si{background:#0B4F8A;color:#FFFFFF}.sec-btn-si.peligro{background:#B4412F}' +
    '.sec-wa{position:fixed;right:14px;bottom:calc(86px + env(safe-area-inset-bottom,0px));z-index:900;display:flex;align-items:center;gap:8px;background:#1F8A4C;color:#FFFFFF;text-decoration:none;border-radius:28px;padding:12px 16px 12px 13px;font:700 14px "Public Sans",sans-serif;box-shadow:0 6px 20px rgba(31,138,76,.4)}' +
    '.sec-wa svg{width:24px;height:24px;flex:none}.sec-wa.compacto span{display:none}.sec-wa.compacto{padding:13px}' +
    '@media (max-width:600px){.sec-wa span{display:none}.sec-wa{padding:14px;right:12px}}' +
    /* El botón de WhatsApp no tapa ventanas ni enlaces: se oculta con una ventana abierta y en el ingreso sube arriba */
    'body:has(.sec-modal-fondo) .sec-wa,body:has(#cal-overlay) .sec-wa,body:has(#loading-overlay.active) .sec-wa{display:none}' +
    'body:has(#screen-auth.active) .sec-wa{top:12px;bottom:auto}' +
    '.page{padding-bottom:110px!important}' +
    '.auth-body,.auth-top+.auth-body{padding-bottom:90px!important}' +
    '.sec-firma{display:flex;align-items:center;justify-content:center;gap:8px;margin:22px auto 8px;font:500 12px "Public Sans",sans-serif;color:#5D6B78;text-decoration:none}' +
    '.sec-firma svg{width:22px;height:22px}.sec-firma b{font:700 13px "Barlow Condensed",sans-serif;letter-spacing:.04em;color:#1E3A4C}.sec-firma b i{font-style:normal;color:#E0A21A}' +
    '@media print{.sec-wa,.sec-toast-zona{display:none!important}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);

  function zona() {
    var z = document.querySelector('.sec-toast-zona');
    if (!z) { z = document.createElement('div'); z.className = 'sec-toast-zona'; z.setAttribute('role', 'status'); z.setAttribute('aria-live', 'polite'); document.body.appendChild(z); }
    return z;
  }

  // aviso('Guardado') · aviso('Algo falló', 'error') · aviso('Revise...', 'aviso')
  window.aviso = function (texto, tipo, ms) {
    var t = document.createElement('div');
    t.className = 'sec-toast ' + (tipo || '');
    var ic = document.createElement('span'); ic.className = 'ic'; ic.textContent = tipo === 'error' ? '\u26A0' : tipo === 'aviso' ? '\u2139' : '\u2714';
    var m = document.createElement('span'); m.textContent = String(texto || '');
    var x = document.createElement('span'); x.className = 'x'; x.textContent = '\u00D7'; x.setAttribute('aria-label', 'Cerrar');
    t.appendChild(ic); t.appendChild(m); t.appendChild(x);
    var z = zona();
    var hayVentana = !!document.querySelector('.sec-modal-fondo, #cal-overlay');
    if (!tipo) Array.prototype.slice.call(z.querySelectorAll('.sec-toast.error, .sec-toast.aviso')).forEach(function (v) { v.remove(); });
    while (z.children.length >= (hayVentana ? 1 : 2)) z.removeChild(z.firstChild);
    z.appendChild(t);
    function quitar() { t.classList.remove('ver'); setTimeout(function () { t.remove(); }, 300); }
    t.onclick = quitar;
    requestAnimationFrame(function () { t.classList.add('ver'); });
    // Duran lo suficiente para leerlos: 6 s los normales y 10 s los errores (más si el texto es largo)
    setTimeout(quitar, ms || Math.max(tipo === 'error' ? 10000 : 6000, String(texto || '').length * 70));
  };
  // Las alertas antiguas pasan a ser avisos dentro de la pantalla
  window.alert = function (msg) {
    var s = String(msg || '');
    var tipo = /error|no se pudo|inválid|invalid|venció/i.test(s) ? 'error' : '';
    window.aviso(s.replace(/^[✅⚠️❌\s]+/u, ''), tipo);
  };

  // confirmar('¿Completar el servicio?', {titulo, si, no, peligro}) → Promise<boolean>
  window.confirmar = function (texto, op) {
    op = op || {};
    return new Promise(function (resolve) {
      var fondo = document.createElement('div');
      fondo.className = 'sec-modal-fondo';
      fondo.innerHTML = '<div class="sec-modal" role="dialog" aria-modal="true"><h3></h3><p></p><div class="sec-modal-botones"><button class="sec-btn-no" type="button"></button><button class="sec-btn-si" type="button"></button></div></div>';
      fondo.querySelector('h3').textContent = op.titulo || 'Confirmar';
      fondo.querySelector('p').textContent = texto;
      var bNo = fondo.querySelector('.sec-btn-no'), bSi = fondo.querySelector('.sec-btn-si');
      bNo.textContent = op.no || 'Cancelar';
      bSi.textContent = op.si || 'Sí, continuar';
      if (op.peligro) bSi.classList.add('peligro');
      function cerrar(v) { fondo.remove(); resolve(v); }
      fondo.__cerrar = function () { cerrar(false); };
      bNo.onclick = function () { cerrar(false); };
      bSi.onclick = function () { cerrar(true); };
      fondo.onclick = function (e) { if (e.target === fondo) cerrar(false); };
      document.body.appendChild(fondo);
      bSi.focus();
    });
  };

  // Enlace de WhatsApp con mensaje según quién escribe
  var textos = {
    paciente: 'Hola, soy paciente de Salud en Casa y necesito ayuda',
    profesional: 'Hola, soy profesional de Salud en Casa y necesito ayuda',
    admin: 'Hola, escribo desde el panel de Salud en Casa',
    publico: 'Hola, quiero información sobre los servicios de Salud en Casa'
  };
  window.enlaceWhatsApp = function (texto) {
    return 'https://wa.me/' + IPS_WHATSAPP + '?text=' + encodeURIComponent(texto || textos[ROL] || textos.publico);
  };
  var ICONO_WA = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.4.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.7 11.8 11.8 0 0 0 4.5 4c1.7.7 2.3.8 3.2.6a2.7 2.7 0 0 0 1.8-1.3 2.2 2.2 0 0 0 .2-1.3c-.1-.1-.3-.2-.5-.3z"/></svg>';

  window.whatsappServicio = function (s) {
    // Mensaje prellenado con el servicio, para que la IPS sepa de inmediato de qué se trata
    var ref = 'RE-' + String(s.id || '').slice(0, 8).toUpperCase();
    var f = s.fechaSolicitud || s.createdAt;
    var fecha = f ? new Date(f).toLocaleDateString('es-CO', { day: 'numeric', month: 'long', timeZone: 'America/Bogota' }) : '';
    return enlaceWhatsApp('Hola, tengo una pregunta sobre el servicio ' + ref + (fecha ? ' del ' + fecha : '') + '.');
  };

  var LOGO = '<svg viewBox="0 0 200 200" aria-hidden="true"><rect x="4" y="4" width="192" height="192" rx="46" fill="#1E3A4C"/><g stroke="#FFFFFF" stroke-linecap="round"><polygon points="100,42 150.2,71 150.2,129 100,158 49.8,129 49.8,71" fill="none" stroke-opacity=".35" stroke-width="4"/><path d="M100 100L100 42M100 100L150.2 71M100 100L150.2 129M100 100L100 158M100 100L49.8 129M100 100L49.8 71" stroke-width="6"/></g><g fill="#FFFFFF"><circle cx="150.2" cy="71" r="10"/><circle cx="150.2" cy="129" r="10"/><circle cx="100" cy="158" r="10"/><circle cx="49.8" cy="129" r="10"/><circle cx="49.8" cy="71" r="10"/></g><circle cx="100" cy="42" r="13" fill="#E0A21A"/><circle cx="100" cy="100" r="20" fill="#E0A21A"/></svg>';
  window.firmaSkyNet = function () {
    var a = document.createElement('a');
    a.className = 'sec-firma'; a.href = 'https://skynetgenesis.com'; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = LOGO + '<span>Tecnología <b>SKYNET <i>GENESIS</i></b></span>';
    return a;
  };

  // Las consultas que hace la app sola (refrescos automáticos) llevan X-Segundo-Plano: así el servidor
  // no las cuenta como "uso" y la sesión igual se cierra si la persona dejó la app abierta y se fue.
  var fetchBase = window.fetch;
  window.marcarSegundoPlano = function (ms) { window.__fondoHasta = Date.now() + (ms || 4000); };
  window.fetch = function (url, opts) {
    if (window.__fondoHasta && Date.now() < window.__fondoHasta && typeof url === 'string' && url.indexOf('/api/') >= 0 && url.indexOf('/api/cambios') < 0) {
      opts = Object.assign({}, opts || {});
      var h = new Headers(opts.headers || {});
      h.set('X-Segundo-Plano', '1');
      opts.headers = h;
    }
    return fetchBase.apply(this, [url, opts]);
  };

  // vigilarCambios(API, alCambiar, ms, limiteMs, seguir): pregunta al servidor cada ms (sin tocar la base de datos)
  // si hubo cambios y solo entonces llama a alCambiar(). No consulta con la pantalla oculta, ni cuando nadie
  // toca la app por más de limiteMs (5 min por defecto), salvo que seguir() diga que hay algo en curso.
  window.vigilarCambios = function (api, alCambiar, ms, limiteMs, seguir) {
    var ultima = null, timer = null, parado = false, ultimoUso = Date.now(), limite = limiteMs || 5 * 60 * 1000;
    ['click', 'keydown', 'touchstart', 'scroll'].forEach(function (ev) {
      document.addEventListener(ev, function () { ultimoUso = Date.now(); }, { passive: true });
    });
    function revisar() {
      if (parado || document.hidden) return;
      var enCurso = false; try { enCurso = !!(seguir && seguir()); } catch (e) {}
      if (!enCurso && Date.now() - ultimoUso > limite) return;
      fetch(api + '/api/cambios', { cache: 'no-store' }).then(function (r) { return r.ok ? r.json() : null; }).then(function (d) {
        if (!d || d.v == null) return;
        if (ultima !== null && d.v !== ultima) { window.marcarSegundoPlano(); try { alCambiar(); } catch (e) {} }
        ultima = d.v;
      }).catch(function () {});
    }
    revisar();
    timer = setInterval(revisar, ms || 20000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { ultimoUso = Date.now(); revisar(); } });
    return function detener() { parado = true; clearInterval(timer); };
  };

  // vigilarInactividad({minutos, avisoSeg, titulo, texto, si, alCerrar}): si nadie toca la app en 'minutos',
  // pregunta "¿Sigue ahí?" con una cuenta regresiva; si no responde, llama a alCerrar() (cerrar sesión).
  // Si la pantalla estuvo oculta más tiempo del permitido, cierra apenas vuelve.
  window.vigilarInactividad = function (op) {
    op = op || {};
    var limite = (op.minutos || 15) * 60 * 1000, aviso = (op.avisoSeg || 120) * 1000;
    var ultimoUso = Date.now(), fondo = null, cuenta = null, timer = null, activo = true, ultimoAviso = Date.now();
    function usar() {
      if (fondo) return;
      ultimoUso = Date.now();
      // Si la persona sigue usando la app sin cargar datos, se le avisa al servidor cada 4 minutos
      if (op.marcarUso && Date.now() - ultimoAviso > 4 * 60 * 1000) { ultimoAviso = Date.now(); try { op.marcarUso(); } catch (e) {} }
    }
    ['click', 'keydown', 'touchstart', 'scroll', 'mousemove'].forEach(function (ev) {
      document.addEventListener(ev, usar, { passive: true });
    });
    function cerrarAviso() { if (fondo) { fondo.remove(); fondo = null; } clearInterval(cuenta); }
    function vencer() { if (!activo) return; activo = false; cerrarAviso(); clearInterval(timer); try { op.alCerrar && op.alCerrar(); } catch (e) {} }
    function preguntar() {
      if (fondo) return;
      var fin = ultimoUso + limite + aviso;
      fondo = document.createElement('div');
      fondo.className = 'sec-modal-fondo';
      fondo.setAttribute('data-inactividad', '1');
      fondo.innerHTML = '<div class="sec-modal" role="dialog" aria-modal="true"><h3></h3><p></p><p style="font-weight:700;font-size:22px;text-align:center;margin:-6px 0 14px" class="sec-cuenta"></p><div class="sec-modal-botones"><button class="sec-btn-si" type="button"></button></div></div>';
      fondo.querySelector('h3').textContent = op.titulo || '¿Sigue ahí?';
      fondo.querySelector('p').textContent = op.texto || 'Por su seguridad, cerraremos la sesión si no responde.';
      var b = fondo.querySelector('.sec-btn-si');
      b.textContent = op.si || 'Sí, sigo aquí';
      b.onclick = function () { cerrarAviso(); ultimoUso = Date.now(); ultimoAviso = Date.now(); try { op.marcarUso && op.marcarUso(); op.alSeguir && op.alSeguir(); } catch (e) {} };
      fondo.__cerrar = b.onclick; // el botón atrás del celular cuenta como "Sí, sigo aquí"
      document.body.appendChild(fondo);
      function pintar() {
        var falta = Math.max(0, Math.round((fin - Date.now()) / 1000));
        var c = fondo && fondo.querySelector('.sec-cuenta');
        if (c) c.textContent = Math.floor(falta / 60) + ':' + ('0' + (falta % 60)).slice(-2);
        if (falta <= 0) vencer();
      }
      pintar(); cuenta = setInterval(pintar, 1000);
    }
    function revisar() {
      if (!activo) return;
      var pausa = false; try { pausa = !!(op.pausar && op.pausar()); } catch (e) {}
      if (pausa) { if (!fondo) ultimoUso = Date.now(); return; }
      var quieto = Date.now() - ultimoUso;
      if (quieto >= limite + aviso) vencer();
      else if (quieto >= limite) preguntar();
    }
    timer = setInterval(revisar, 5000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) revisar(); });
    return {
      detener: function () { activo = false; cerrarAviso(); clearInterval(timer); },
      usar: function () { ultimoUso = Date.now(); },
      revisar: revisar,
      _simular: function (ms) { ultimoUso -= ms; revisar(); } // solo para pruebas
    };
  };

  // Agrega el botón "Mostrar/Ocultar" a todos los campos de contraseña (también a los que aparecen después)
  function ponerOjos(raiz) {
    (raiz || document).querySelectorAll('input[type=password]:not([data-ojo])').forEach(function (inp) {
      inp.setAttribute('data-ojo', '1');
      var envoltura = document.createElement('span'); envoltura.className = 'sec-clave';
      var mb = getComputedStyle(inp).marginBottom;
      inp.parentNode.insertBefore(envoltura, inp); envoltura.appendChild(inp);
      // el margen pasa a la envoltura para que el botón quede centrado en la casilla
      if (mb && mb !== '0px') { envoltura.style.marginBottom = mb; inp.style.marginBottom = '0'; }
      var b = document.createElement('button'); b.type = 'button'; b.className = 'sec-ojo'; b.textContent = 'Mostrar';
      b.setAttribute('aria-label', 'Mostrar u ocultar la contraseña');
      b.onclick = function () { var ver = inp.type === 'password'; inp.type = ver ? 'text' : 'password'; b.textContent = ver ? 'Ocultar' : 'Mostrar'; inp.focus(); };
      envoltura.appendChild(b);
    });
  }
  window.ponerOjos = ponerOjos;

  // Mensaje claro cuando falla la conexión (en vez de "Failed to fetch")
  window.mensajeRed = function (e, porDefecto) {
    var m = String((e && e.message) || '');
    if ((e && e.name === 'TypeError') || /failed to fetch|networkerror|load failed/i.test(m)) return 'Sin conexión. Revise su internet: sus datos no se perdieron.';
    return m || porDefecto || 'Algo salió mal. Intente de nuevo.';
  };

  // Botón atrás del celular dentro de una ventana abierta: la cierra como si pulsara "Cancelar" (o "Sí, sigo aquí")
  window.cerrarVentanaAbierta = function () {
    var todas = document.querySelectorAll('.sec-modal-fondo, #cal-overlay');
    var m = todas[todas.length - 1]; // la de encima
    if (!m) return false;
    if (typeof m.__cerrar === 'function') m.__cerrar(); else m.remove();
    return true;
  };

  // Fechas siempre en hora de Colombia
  window.fechaCO = function (d, conHora) {
    if (!d) return '—';
    var f = new Date(d); if (isNaN(f)) return '—';
    var op = { timeZone: 'America/Bogota', day: '2-digit', month: 'short', year: 'numeric' };
    if (conHora) { op.hour = '2-digit'; op.minute = '2-digit'; }
    return f.toLocaleString('es-CO', op);
  };

  // Etiqueta cada celda con el título de su columna (en el celular las tablas se ven como tarjetas)
  window.etiquetarTablas = function (raiz) {
    (raiz || document).querySelectorAll('table').forEach(function (tabla) {
      var ths = Array.prototype.map.call(tabla.querySelectorAll('thead th'), function (th) { return th.textContent.trim(); });
      if (!ths.length) return;
      tabla.querySelectorAll('tbody tr').forEach(function (tr) {
        var tds = tr.children;
        if (tds.length === 1) { tr.classList.add('fila-unica'); return; }
        for (var i = 0; i < tds.length; i++) if (ths[i] && !tds[i].hasAttribute('data-label')) tds[i].setAttribute('data-label', ths[i]);
      });
    });
  };

  // Íconos y nombres cortos de los servicios (el nombre oficial y el precio vienen del catálogo de la IPS)
  window.ICONOS_SERVICIO = { curacion: '\u{1FA79}', medicacion: '\u{1F48A}', inyeccion: '\u{1F489}', control: '\u{1FA7A}', cuidado_basico: '\u{1F6C1}', urgencia: '\u{1F6A8}',
    consulta_medica: '\u{1F468}\u200D\u2695\uFE0F', terapia_fisica: '\u{1F9BF}', terapia_ocupacional: '\u{1F9E9}', terapia_respiratoria: '\u{1FAC1}', terapia_conductual: '\u{1F9E0}', psicologia: '\u{1F4AC}' };
  window.NOMBRES_SERVICIO = { curacion: 'Curación', medicacion: 'Medicación', inyeccion: 'Inyección', control: 'Control', cuidado_basico: 'Cuidado básico', urgencia: 'Atención prioritaria',
    consulta_medica: 'Consulta médica', terapia_fisica: 'Terapia física', terapia_ocupacional: 'Terapia ocupacional', terapia_respiratoria: 'Terapia respiratoria', terapia_conductual: 'Terapia conductual', psicologia: 'Psicología' };

  // Foto tomada con el celular → JPEG liviano (lado mayor 1600 px y, si hace falta, menos calidad) para no llenar la base
  window.comprimirImagen = function (archivo, maxBytes) {
    maxBytes = maxBytes || 650 * 1024;
    return new Promise(function (ok, mal) {
      if (!archivo || !/^image\//.test(archivo.type)) return mal(new Error('Elija una foto (JPG o PNG).'));
      var lector = new FileReader();
      lector.onerror = function () { mal(new Error('No se pudo leer la foto.')); };
      lector.onload = function () {
        var img = new Image();
        img.onerror = function () { mal(new Error('No se pudo abrir la foto. Intente con otra.')); };
        img.onload = function () {
          var lado = 1600, calidad = 0.72, intento = 0, url = '';
          do {
            var esc = Math.min(1, lado / Math.max(img.width, img.height));
            var c = document.createElement('canvas'); c.width = Math.round(img.width * esc); c.height = Math.round(img.height * esc);
            var g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
            url = c.toDataURL('image/jpeg', calidad);
            lado = Math.round(lado * 0.8); calidad = Math.max(0.45, calidad - 0.08); intento++;
          } while (url.length * 0.75 > maxBytes && intento < 8);
          if (url.length * 0.75 > maxBytes) return mal(new Error('La foto quedó muy pesada. Tómela de nuevo más cerca del papel.'));
          ok(url);
        };
        img.src = lector.result;
      };
      lector.readAsDataURL(archivo);
    });
  };
  // PDF tal cual (máximo 1,5 MB)
  window.leerPdf = function (archivo) {
    return new Promise(function (ok, mal) {
      if (!archivo || archivo.type !== 'application/pdf') return mal(new Error('Elija un PDF.'));
      if (archivo.size > 1536 * 1024) return mal(new Error('El PDF pesa más de 1,5 MB. Tome mejor una foto del documento.'));
      var l = new FileReader(); l.onload = function () { ok(l.result); }; l.onerror = function () { mal(new Error('No se pudo leer el PDF.')); }; l.readAsDataURL(archivo);
    });
  };
  // Muestra un archivo protegido (orden médica, documento) en una ventana; los PDF se abren aparte
  window.verArchivo = async function (url, token, titulo) {
    try {
      var r = await fetch(url, { headers: { 'Authorization': 'Bearer ' + token } });
      if (!r.ok) { var e = await r.json().catch(function () { return {}; }); throw new Error(e.error || 'No se pudo abrir el archivo'); }
      var b = await r.blob(), u = URL.createObjectURL(b);
      if (b.type === 'application/pdf') { window.open(u, '_blank', 'noopener'); setTimeout(function () { URL.revokeObjectURL(u); }, 60000); return true; }
      var fondo = document.createElement('div');
      fondo.className = 'sec-modal-fondo';
      fondo.innerHTML = '<div class="sec-modal" role="dialog" aria-modal="true" style="max-width:640px"><h3></h3><img alt="" style="width:100%;border:1px solid #DCE5EE;border-radius:10px;margin:6px 0 14px"><div class="sec-modal-botones"><button class="sec-btn-si" type="button">Cerrar</button></div></div>';
      fondo.querySelector('h3').textContent = titulo || 'Archivo';
      fondo.querySelector('img').src = u; fondo.querySelector('img').alt = titulo || 'Archivo';
      var cerrar = function () { fondo.remove(); URL.revokeObjectURL(u); };
      fondo.__cerrar = cerrar; fondo.querySelector('.sec-btn-si').onclick = cerrar;
      document.body.appendChild(fondo);
      return true;
    } catch (e) { window.aviso(window.mensajeRed ? window.mensajeRed(e) : e.message, 'error'); return false; }
  };

  // ── Ubicación aproximada (para la seguridad de la visita). Si la persona no la da, sigue sin ella ──
  window.ubicacionActual = function (ms) {
    return new Promise(function (ok) {
      if (!navigator.geolocation) return ok(null);
      var listo = false, t = setTimeout(function () { if (!listo) { listo = true; ok(null); } }, ms || 6000);
      navigator.geolocation.getCurrentPosition(function (p) { if (listo) return; listo = true; clearTimeout(t); ok({ lat: Math.round(p.coords.latitude * 1e6) / 1e6, lng: Math.round(p.coords.longitude * 1e6) / 1e6 }); },
        function () { if (listo) return; listo = true; clearTimeout(t); ok(null); }, { enableHighAccuracy: true, timeout: ms || 6000, maximumAge: 60000 });
    });
  };

  // ── Foto del profesional (aprobada por la IPS). Se pide con la sesión y se muestra en <img data-foto-prof="id"> ──
  var fotosCache = {};
  window.cargarFotosProfesionales = function (api, token, raiz) {
    (raiz || document).querySelectorAll('img[data-foto-prof]').forEach(function (img) {
      var id = img.getAttribute('data-foto-prof');
      if (!id || img.__cargada) return;
      img.__cargada = true;
      var poner = function (u) { if (u) { img.src = u; img.hidden = false; } };
      if (fotosCache[id] !== undefined) return poner(fotosCache[id]);
      fetch(api + '/api/profesionales/' + id + '/foto', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function (r) { return r.ok ? r.blob() : null; })
        .then(function (b) { fotosCache[id] = b ? URL.createObjectURL(b) : null; poner(fotosCache[id]); })
        .catch(function () {});
    });
  };

  // ── Pedir un dato corto en una ventana (código de llegada, fecha…) ──
  window.pedirDato = function (op) {
    return new Promise(function (resolve) {
      var f = document.createElement('div');
      f.className = 'sec-modal-fondo';
      f.innerHTML = '<div class="sec-modal" role="dialog" aria-modal="true"><h3></h3><p></p><input style="width:100%;box-sizing:border-box;padding:12px;border:1px solid #DCE5EE;border-radius:10px;font:700 20px \'Public Sans\',sans-serif;margin-bottom:14px"><div class="sec-modal-botones"><button class="sec-btn-no" type="button">Cancelar</button><button class="sec-btn-si" type="button"></button></div></div>';
      f.querySelector('h3').textContent = op.titulo || '';
      f.querySelector('p').textContent = op.texto || '';
      var inp = f.querySelector('input');
      inp.type = op.tipo || 'text';
      if (op.inputmode) inp.setAttribute('inputmode', op.inputmode);
      if (op.maxlength) inp.maxLength = op.maxlength;
      if (op.min) inp.min = op.min;
      if (op.max) inp.max = op.max;
      if (op.valor) inp.value = op.valor;
      if (op.tipo === 'text' || !op.tipo) inp.style.letterSpacing = op.espaciado || 'normal';
      f.querySelector('.sec-btn-si').textContent = op.si || 'Aceptar';
      var fin = function (v) { f.remove(); resolve(v); };
      f.__cerrar = function () { fin(null); };
      f.querySelector('.sec-btn-no').onclick = function () { fin(null); };
      f.querySelector('.sec-btn-si').onclick = function () { var v = inp.value.trim(); if (op.validar && !op.validar(v)) { window.aviso(op.error || 'Revise el dato', 'aviso'); return; } fin(v); };
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') f.querySelector('.sec-btn-si').click(); });
      document.body.appendChild(f);
      setTimeout(function () { inp.focus(); }, 50);
    });
  };

  // ── Chat del servicio (paciente ↔ profesional). Se actualiza cada 5 segundos mientras está abierto ──
  window.abrirChat = function (api, token, servicioId, titulo) {
    var f = document.createElement('div');
    f.className = 'sec-modal-fondo';
    f.innerHTML = '<div class="sec-modal" role="dialog" aria-modal="true" style="max-width:480px;display:flex;flex-direction:column;max-height:88vh">' +
      '<h3></h3><div class="chat-aviso" style="font-size:12px;color:#5D6B78;margin-bottom:8px">Solo para coordinar la visita. No comparta datos de tarjetas ni claves. La IPS puede leer este chat.</div>' +
      '<div class="chat-lista" style="flex:1;overflow-y:auto;min-height:180px;max-height:50vh;background:#F4F8FB;border:1px solid #DCE5EE;border-radius:10px;padding:10px;display:flex;flex-direction:column;gap:6px"></div>' +
      '<div class="chat-escribir" style="display:flex;gap:8px;margin-top:10px"><input maxlength="500" placeholder="Escriba un mensaje" style="flex:1;min-width:0;padding:11px;border:1px solid #DCE5EE;border-radius:10px;font:inherit"><button type="button" class="chat-enviar" style="padding:0 16px;border:0;border-radius:10px;background:#14A38B;color:#fff;font-weight:700;cursor:pointer">Enviar</button></div>' +
      '<div class="sec-modal-botones" style="margin-top:10px"><button class="sec-btn-no" type="button">Cerrar</button></div></div>';
    f.querySelector('h3').textContent = titulo || 'Mensajes';
    var lista = f.querySelector('.chat-lista'), inp = f.querySelector('input'), btn = f.querySelector('.chat-enviar');
    var timer = null, ultimo = '';
    function cerrar() { clearInterval(timer); f.remove(); }
    f.__cerrar = cerrar;
    f.querySelector('.sec-btn-no').onclick = cerrar;
    async function cargar(fondo) {
      try {
        var h = { 'Authorization': 'Bearer ' + token };
        if (fondo) h['x-segundo-plano'] = '1'; // las revisiones automáticas no cuentan como uso
        var r = await fetch(api + '/api/servicios/' + servicioId + '/mensajes', { headers: h });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) { lista.innerHTML = ''; var e = document.createElement('div'); e.textContent = d.error || 'Chat no disponible'; lista.appendChild(e); f.querySelector('.chat-escribir').hidden = true; clearInterval(timer); return; }
        f.querySelector('.chat-escribir').hidden = !d.puedeEscribir;
        var firma = (d.items || []).map(function (m) { return m.id; }).join(',');
        if (firma === ultimo) return;
        ultimo = firma;
        try { var its = d.items || []; if (its.length) localStorage.setItem('sec_chat_visto_' + servicioId, its[its.length - 1].id); } catch (e) {}
        if (window.__pintarChatNuevo) window.__pintarChatNuevo(servicioId, false);
        lista.innerHTML = '';
        if (!(d.items || []).length) { var v = document.createElement('div'); v.style.cssText = 'color:#5D6B78;font-size:13px;text-align:center;margin:auto'; v.textContent = 'Aún no hay mensajes.'; lista.appendChild(v); }
        (d.items || []).forEach(function (m) {
          var mio = m.rol === d.yo, b = document.createElement('div');
          b.style.cssText = 'max-width:80%;padding:8px 11px;border-radius:12px;font-size:14px;white-space:pre-wrap;word-break:break-word;' + (mio ? 'align-self:flex-end;background:#0B4F8A;color:#fff' : 'align-self:flex-start;background:#fff;border:1px solid #DCE5EE');
          b.textContent = m.texto;
          var h = document.createElement('div');
          h.style.cssText = 'font-size:11px;opacity:.75;margin-top:2px';
          h.textContent = (d.yo === 'admin' ? (m.rol === 'paciente' ? 'Paciente · ' : 'Profesional · ') : '') + new Date(m.createdAt).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Bogota' });
          b.appendChild(h);
          lista.appendChild(b);
        });
        lista.scrollTop = lista.scrollHeight;
      } catch (e) {}
    }
    async function enviar() {
      var t = inp.value.trim();
      if (!t || btn.disabled) return;
      btn.disabled = true;
      try {
        var r = await fetch(api + '/api/servicios/' + servicioId + '/mensajes', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ texto: t }) });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(d.error || 'No se pudo enviar el mensaje');
        inp.value = '';
        await cargar();
      } catch (e) { window.aviso(window.mensajeRed(e), 'error'); }
      btn.disabled = false;
      inp.focus();
    }
    btn.onclick = enviar;
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') enviar(); });
    document.body.appendChild(f);
    cargar();
    timer = setInterval(function () { if (!document.body.contains(f)) { clearInterval(timer); return; } cargar(true); }, 5000);
  };

  // ── Aviso de mensaje nuevo en el chat ──
  // Revisa cada 15 s los chats de los servicios que están en pantalla. Si llegó un mensaje de la otra persona
  // que no se ha leído: punto rojo en el botón "Mensajes", aviso arriba con botón para abrirlo, sonido y vibración.
  (function () {
    var css = document.createElement('style');
    css.textContent = '.chat-nuevo{position:relative;animation:chatLatido 1.2s ease-in-out infinite;border-color:#B4412F!important}' +
      '.chat-nuevo::after{content:"Nuevo";position:absolute;top:-9px;right:-6px;background:#B4412F;color:#fff;font:700 11px/1 "Public Sans",sans-serif;padding:4px 7px;border-radius:999px;box-shadow:0 2px 6px rgba(0,0,0,.25)}' +
      '@keyframes chatLatido{0%,100%{box-shadow:0 0 0 0 rgba(180,65,47,.45)}50%{box-shadow:0 0 0 7px rgba(180,65,47,0)}}' +
      '.sec-toast .abrir-chat{margin-left:8px;background:#fff;color:#0B4F8A;border:0;border-radius:8px;padding:6px 10px;font:700 14px "Public Sans",sans-serif;cursor:pointer;flex:none}';
    document.head.appendChild(css);
    function botones(id) {
      return Array.prototype.slice.call(document.querySelectorAll('[onclick*="abrirChat"]')).filter(function (b) { return (b.dataset.sid || b.dataset.id) === id; });
    }
    window.__pintarChatNuevo = function (id, nuevo) { botones(id).forEach(function (b) { b.classList.toggle('chat-nuevo', !!nuevo); }); };
    function sonar() {
      try { if (navigator.vibrate) navigator.vibrate([180, 90, 180]); } catch (e) {}
      try {
        var C = window.AudioContext || window.webkitAudioContext; if (!C) return;
        var c = window.__chatAudio || (window.__chatAudio = new C());
        [0, 0.22].forEach(function (t) {
          var o = c.createOscillator(), g = c.createGain();
          o.frequency.value = 880; o.connect(g); g.connect(c.destination);
          g.gain.setValueAtTime(0.0001, c.currentTime + t); g.gain.exponentialRampToValueAtTime(0.25, c.currentTime + t + 0.02);
          g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + t + 0.18);
          o.start(c.currentTime + t); o.stop(c.currentTime + t + 0.2);
        });
      } catch (e) {}
    }
    function lee(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
    function guarda(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
    var revisando = false;
    async function revisar() {
      if (revisando || document.hidden) return;
      var api, tk;
      try { api = API; tk = token; } catch (e) { return; }
      if (!api || !tk) return;
      var ids = [];
      Array.prototype.slice.call(document.querySelectorAll('[onclick*="abrirChat"]')).forEach(function (b) {
        var id = b.dataset.sid || b.dataset.id; if (id && ids.indexOf(id) < 0) ids.push(id);
      });
      if (!ids.length) return;
      revisando = true;
      try {
        for (var i = 0; i < ids.length && i < 6; i++) {
          var id = ids[i];
          if (document.querySelector('.sec-modal-fondo .chat-lista')) continue; // hay un chat abierto
          var r = await fetch(api + '/api/servicios/' + id + '/mensajes', { headers: { 'Authorization': 'Bearer ' + tk, 'x-segundo-plano': '1' } }).catch(function () { return null; });
          if (!r || !r.ok) continue;
          var d = await r.json().catch(function () { return {}; });
          var its = d.items || [];
          var otros = its.filter(function (m) { return m.rol !== d.yo; });
          if (!otros.length) { window.__pintarChatNuevo(id, false); continue; }
          var ult = otros[otros.length - 1];
          var visto = lee('sec_chat_visto_' + id);
          var leido = visto && its.some(function (m, k) { return m.id === visto && k >= its.indexOf(ult); });
          window.__pintarChatNuevo(id, !leido);
          if (!leido && lee('sec_chat_avisado_' + id) !== ult.id) {
            guarda('sec_chat_avisado_' + id, ult.id);
            var b = botones(id)[0];
            var quien = d.yo === 'paciente' ? 'su profesional' : 'el paciente';
            window.aviso('Nuevo mensaje de ' + quien + ': "' + (ult.texto.length > 70 ? ult.texto.slice(0, 70) + '…' : ult.texto) + '"', 'aviso', 15000);
            var t = document.querySelector('.sec-toast-zona .sec-toast:last-child');
            if (t && b) {
              var ab = document.createElement('button'); ab.className = 'abrir-chat'; ab.type = 'button'; ab.textContent = 'Abrir';
              ab.onclick = function (ev) { ev.stopPropagation(); t.remove(); b.click(); };
              t.insertBefore(ab, t.querySelector('.x'));
            }
            sonar();
          }
        }
      } finally { revisando = false; }
    }
    setInterval(revisar, 15000);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) setTimeout(revisar, 800); });
  })();

  // ── Botón de emergencia durante el servicio ──
  window.botonEmergencia = function (api, token, servicioId) {
    var f = document.createElement('div');
    f.className = 'sec-modal-fondo';
    f.innerHTML = '<div class="sec-modal" role="dialog" aria-modal="true"><h3 style="color:#B4412F">🆘 Emergencia</h3>' +
      '<p>Si hay riesgo para la vida (accidente, agresión, paciente grave), llame primero al 123. Luego avise a la IPS: le llamaremos de inmediato.</p>' +
      '<a href="tel:123" style="display:block;text-align:center;background:#B4412F;color:#fff;padding:13px;border-radius:10px;font-weight:800;text-decoration:none;margin-bottom:8px">📞 Llamar al 123 (emergencias)</a>' +
      '<button type="button" class="em-ips" style="width:100%;padding:13px;border:0;border-radius:10px;background:#0B4F8A;color:#fff;font:800 15px \'Public Sans\',sans-serif;margin-bottom:8px;cursor:pointer">🚨 Avisar a la IPS ahora (con mi ubicación)</button>' +
      '<a href="tel:3128886611" style="display:block;text-align:center;background:#E8F1FA;color:#0B4F8A;padding:12px;border-radius:10px;font-weight:700;text-decoration:none;margin-bottom:12px">Llamar a la IPS · 312 888 6611</a>' +
      '<div class="sec-modal-botones"><button class="sec-btn-no" type="button">Cerrar</button></div></div>';
    var cerrar = function () { f.remove(); };
    f.__cerrar = cerrar;
    f.querySelector('.sec-btn-no').onclick = cerrar;
    f.querySelector('.em-ips').onclick = async function () {
      var b = this; if (b.disabled) return; b.disabled = true; b.textContent = 'Enviando alerta...';
      var pos = await window.ubicacionActual(5000);
      try {
        var r = await fetch(api + '/api/servicios/' + servicioId + '/alerta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify(pos || {}) });
        var d = await r.json().catch(function () { return {}; });
        if (!r.ok) throw new Error(d.error || 'No se pudo enviar la alerta. Llame a la IPS.');
        b.textContent = '✔ Alerta enviada a la IPS';
        window.aviso(d.mensaje || 'La IPS recibió su alerta.', '', 12000);
      } catch (e) { b.disabled = false; b.textContent = '🚨 Avisar a la IPS ahora (con mi ubicación)'; window.aviso(window.mensajeRed(e), 'error'); }
    };
    document.body.appendChild(f);
  };

  // Fecha y hora de una cita, en palabras ("sábado 7 de noviembre, 3:00 p. m.")
  window.fechaCita = function (d) {
    return new Date(d).toLocaleString('es-CO', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/Bogota' });
  };

  document.addEventListener('DOMContentLoaded', function () {
    ponerOjos();
    new MutationObserver(function () { ponerOjos(); }).observe(document.body, { childList: true, subtree: true });
    if (!document.body.hasAttribute('data-sin-whatsapp')) {
      var wa = document.createElement('a');
      wa.className = 'sec-wa' + (ROL === 'admin' ? ' compacto' : '');
      wa.href = enlaceWhatsApp(); wa.target = '_blank'; wa.rel = 'noopener';
      wa.setAttribute('aria-label', 'Escribir por WhatsApp a ' + IPS_NOMBRE);
      wa.innerHTML = ICONO_WA + '<span>WhatsApp IPS</span>';
      document.body.appendChild(wa);
    }
    document.querySelectorAll('[data-firma-skynet]').forEach(function (el) { el.appendChild(firmaSkyNet()); });
  });

  // ── Instalar la app en el celular (ícono en la pantalla de inicio, sin abrir enlaces) ──
  if (ROL === 'paciente' || ROL === 'profesional') {
    var swArchivo = ROL === 'profesional' ? 'sw-enfermero.js' : 'sw-paciente.js';
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register(swArchivo, ROL === 'paciente' ? { scope: './app-paciente.html' } : undefined).catch(function () {});
      });
    }
    var instalarEvt = null;
    var instalada = function () {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || window.navigator.standalone === true;
    };
    var esIOS = /iphone|ipad|ipod/i.test(navigator.userAgent);
    var nombreApp = ROL === 'profesional' ? 'Salud en Casa Pro' : 'Salud en Casa';
    var cssI = '.sec-instalar{position:fixed;left:12px;right:12px;bottom:84px;z-index:9000;max-width:480px;margin:0 auto;background:#FFFFFF;border:1.5px solid #14A38B;border-radius:16px;box-shadow:0 10px 30px rgba(11,79,138,.25);padding:12px 14px;display:flex;gap:12px;align-items:center;font:500 14px/1.35 "Public Sans",sans-serif;color:#1C2B39}' +
      '.sec-instalar img{width:44px;height:44px;border-radius:10px;flex:none}.sec-instalar b{display:block;font-size:15px}' +
      '.sec-instalar .si{background:#14A38B;color:#fff;border:0;border-radius:10px;padding:10px 14px;font:700 14px "Public Sans",sans-serif;cursor:pointer;flex:none}' +
      '.sec-instalar .no{background:none;border:0;font-size:22px;color:#5D6B78;cursor:pointer;flex:none;padding:0 2px}' +
      '.sec-pasos-inst{text-align:left;margin:8px 0 0;padding-left:20px;font:500 15px/1.6 "Public Sans",sans-serif}';
    var stI = document.createElement('style'); stI.textContent = cssI; document.head.appendChild(stI);
    window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); instalarEvt = e; mostrarInstalar(); });
    window.addEventListener('appinstalled', function () { var b = document.getElementById('sec-instalar'); if (b) b.remove(); window.aviso('¡Listo! Ya tiene ' + nombreApp + ' en su pantalla de inicio.'); });
    var instruccionesInstalar = function () {
      var pasos = esIOS
        ? ['Toque el botón <b>Compartir</b> (el cuadrito con la flecha hacia arriba, abajo en Safari).', 'Baje y toque <b>"Agregar a pantalla de inicio"</b>.', 'Toque <b>"Agregar"</b>. Le queda el ícono de ' + nombreApp + ' como cualquier app.']
        : ['Toque los <b>tres puntos ⋮</b> arriba a la derecha de Chrome.', 'Toque <b>"Instalar aplicación"</b> o <b>"Agregar a pantalla principal"</b>.', 'Confirme. Le queda el ícono de ' + nombreApp + ' como cualquier app.'];
      var fondo = document.createElement('div'); fondo.className = 'sec-modal-fondo';
      fondo.innerHTML = '<div class="sec-modal" role="dialog" aria-modal="true"><h3>Instalar ' + nombreApp + '</h3><ol class="sec-pasos-inst">' + pasos.map(function (x) { return '<li>' + x + '</li>'; }).join('') + '</ol><div class="sec-modal-botones"><button class="sec-btn-si" type="button">Entendido</button></div></div>';
      fondo.querySelector('.sec-btn-si').onclick = function () { fondo.remove(); };
      document.body.appendChild(fondo);
    };
    window.instalarApp = function () {
      if (instalarEvt) {
        instalarEvt.prompt();
        instalarEvt.userChoice.then(function () { instalarEvt = null; var b = document.getElementById('sec-instalar'); if (b) b.remove(); }).catch(function () {});
      } else instruccionesInstalar();
    };
    var mostrarInstalar = function () {
      if (instalada() || document.getElementById('sec-instalar') || !document.body) return;
      var hasta = 0; try { hasta = Number(localStorage.getItem('sec_instalar_luego') || 0); } catch (e) {}
      if (Date.now() < hasta) return;
      var b = document.createElement('div'); b.className = 'sec-instalar'; b.id = 'sec-instalar';
      b.innerHTML = '<img src="icon-192.png" alt=""><div style="flex:1"><b>Instale la app en su celular</b>Quedará con su ícono, sin tener que abrir el enlace.</div><button class="si" type="button">Instalar</button><button class="no" type="button" aria-label="Ahora no">×</button>';
      b.querySelector('.si').onclick = window.instalarApp;
      b.querySelector('.no').onclick = function () { try { localStorage.setItem('sec_instalar_luego', String(Date.now() + 3 * 864e5)); } catch (e) {} b.remove(); };
      document.body.appendChild(b);
    };
    document.addEventListener('DOMContentLoaded', function () { setTimeout(mostrarInstalar, 4000); });
  }
})();
