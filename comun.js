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
    '.sec-toast-zona{position:fixed;left:50%;top:16px;transform:translateX(-50%);z-index:9999;display:flex;flex-direction:column;gap:8px;width:calc(100% - 32px);max-width:420px;pointer-events:none}' +
    '.sec-toast{pointer-events:auto;background:#FFFFFF;color:#15232B;border-left:5px solid #1F8A4C;border-radius:10px;padding:12px 14px;font:600 14px/1.4 "Public Sans",system-ui,sans-serif;box-shadow:0 6px 24px rgba(21,35,43,.18);opacity:0;transform:translateY(-8px);transition:all .25s}' +
    '.sec-toast.ver{opacity:1;transform:none}.sec-toast.error{border-left-color:#B4412F}.sec-toast.aviso{border-left-color:#E0A21A}' +
    '.sec-modal-fondo{position:fixed;inset:0;background:rgba(21,35,43,.55);z-index:9998;display:flex;align-items:center;justify-content:center;padding:16px}' +
    '.sec-modal{background:#FFFFFF;color:#15232B;border-radius:14px;padding:22px 20px;width:100%;max-width:380px;font:400 15px/1.5 "Public Sans",system-ui,sans-serif;box-shadow:0 12px 40px rgba(21,35,43,.3)}' +
    '.sec-modal h3{margin:0 0 8px;font:700 22px "Barlow Condensed",sans-serif;color:#1E3A4C}' +
    '.sec-modal p{margin:0 0 18px;white-space:pre-line}' +
    '.sec-modal-botones{display:flex;gap:10px}.sec-modal-botones button{flex:1;padding:12px;border-radius:10px;border:0;font:700 15px "Public Sans",sans-serif;cursor:pointer}' +
    '.sec-btn-no{background:#EEF2F1;color:#15232B}.sec-btn-si{background:#1E3A4C;color:#FFFFFF}.sec-btn-si.peligro{background:#B4412F}' +
    '.sec-wa{position:fixed;right:14px;bottom:calc(86px + env(safe-area-inset-bottom,0px));z-index:900;display:flex;align-items:center;gap:8px;background:#1F8A4C;color:#FFFFFF;text-decoration:none;border-radius:28px;padding:12px 16px 12px 13px;font:700 14px "Public Sans",sans-serif;box-shadow:0 6px 20px rgba(31,138,76,.4)}' +
    '.sec-wa svg{width:24px;height:24px;flex:none}.sec-wa.compacto span{display:none}.sec-wa.compacto{padding:13px}' +
    '@media (max-width:600px){.sec-wa span{display:none}.sec-wa{padding:14px;right:12px}}' +
    '.auth-body,.auth-top+.auth-body{padding-bottom:90px!important}' +
    '.sec-firma{display:flex;align-items:center;justify-content:center;gap:8px;margin:22px auto 8px;font:500 12px "Public Sans",sans-serif;color:#5B6B73;text-decoration:none}' +
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
    t.textContent = String(texto || '');
    zona().appendChild(t);
    requestAnimationFrame(function () { t.classList.add('ver'); });
    setTimeout(function () { t.classList.remove('ver'); setTimeout(function () { t.remove(); }, 300); }, ms || (tipo === 'error' ? 6000 : 3500));
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
    var fecha = f ? new Date(f).toLocaleDateString('es-CO', { day: 'numeric', month: 'long' }) : '';
    return enlaceWhatsApp('Hola, tengo una pregunta sobre el servicio ' + ref + (fecha ? ' del ' + fecha : '') + '.');
  };

  var LOGO = '<svg viewBox="0 0 200 200" aria-hidden="true"><rect x="4" y="4" width="192" height="192" rx="46" fill="#1E3A4C"/><g stroke="#FFFFFF" stroke-linecap="round"><polygon points="100,42 150.2,71 150.2,129 100,158 49.8,129 49.8,71" fill="none" stroke-opacity=".35" stroke-width="4"/><path d="M100 100L100 42M100 100L150.2 71M100 100L150.2 129M100 100L100 158M100 100L49.8 129M100 100L49.8 71" stroke-width="6"/></g><g fill="#FFFFFF"><circle cx="150.2" cy="71" r="10"/><circle cx="150.2" cy="129" r="10"/><circle cx="100" cy="158" r="10"/><circle cx="49.8" cy="129" r="10"/><circle cx="49.8" cy="71" r="10"/></g><circle cx="100" cy="42" r="13" fill="#E0A21A"/><circle cx="100" cy="100" r="20" fill="#E0A21A"/></svg>';
  window.firmaSkyNet = function () {
    var a = document.createElement('a');
    a.className = 'sec-firma'; a.href = 'https://skynetgenesis.com'; a.target = '_blank'; a.rel = 'noopener';
    a.innerHTML = LOGO + '<span>Tecnología <b>SKYNET <i>GENESIS</i></b></span>';
    return a;
  };

  document.addEventListener('DOMContentLoaded', function () {
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
})();
