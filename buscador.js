"use strict";

const { obras, corte, fuente, anexo } = globalThis.INVENTARIO;
const porId = new Map(obras.map(obra => [obra.infobras, obra]));
const $ = id => document.getElementById(id);
const cantidad = new Intl.NumberFormat("es-PE", { maximumFractionDigits: 2 });
const moneda = new Intl.NumberFormat("es-PE", { style: "currency", currency: "PEN" });
const ordenarTexto = new Intl.Collator("es", { sensitivity: "base" }).compare;
const tamPagina = 12;
const sinDato = "Sin dato en el anexo";
const fechaCorte = "30 de junio de 2026";
const filtros = ["q", "dep", "prov", "dist", "tipo", "avance", "orden"];
const comunes = new Set(["en", "de", "del", "la", "las", "el", "los", "y"]);
const etiquetas = {
  original: "Orden del anexo",
  avance: "Mayor avance",
  costo: "Mayor costo de obra",
};
const estados = { pagina: 1, resultados: [] };

function normalizar(texto) {
  return String(texto ?? "").normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

function palabras(texto) {
  return normalizar(texto).match(/[a-z0-9]+/g) ?? [];
}

function claveTerritorial(texto) {
  return palabras(texto).join(" ");
}

function entidadHtml(texto) {
  return String(texto ?? sinDato).replace(/[&<>"']/g, letra => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[letra]);
}

function lugar(obra) {
  return [obra.departamento, obra.provincia, obra.distrito].filter(Boolean).join(" / ");
}

function porcentaje(valor) {
  return valor == null ? sinDato : `${cantidad.format(valor)} %`;
}

function soles(valor) {
  return valor == null ? sinDato : moneda.format(valor);
}

const lugares = new Set();
const indice = new Map(obras.map(obra => {
  const ubicaciones = [obra.departamento, obra.provincia, obra.distrito]
    .filter(Boolean).map(claveTerritorial);
  for (const nombre of ubicaciones) lugares.add(nombre);
  return [obra.infobras, {
    texto: normalizar([
      obra.obra, obra.entidad, lugar(obra), obra.tipo, obra.categoria, obra.subtipo, obra.sector,
    ].join(" ")),
    ubicaciones,
  }];
}));

function interpretarConsulta(texto) {
  const consulta = claveTerritorial(texto);
  const codigo = consulta.match(/^(?:(?:codigo )?(cui|infobras) )?(\d+)$/);
  if (codigo) {
    return { campo: codigo[1], codigo: codigo[2], termino: [], ubicacion: null };
  }
  const cuerpo = consulta
    .replace(/^(?:(?:cuant(?:as|os)|cual(?:es)?(?: son)?|que) )?(?:las )?obras(?: publicas)?(?: (?:estan )?paralizadas)?(?: hay)?(?: |$)/, "")
    .replace(/^en /, "");
  const separador = cuerpo.lastIndexOf(" en ");
  const lugarSolicitado = separador < 0 ? cuerpo : cuerpo.slice(separador + 4);
  const ubicacion = lugares.has(lugarSolicitado) ? lugarSolicitado : null;
  const termino = ubicacion ? (separador < 0 ? "" : cuerpo.slice(0, separador)) : cuerpo;
  return { campo: null, codigo: null, termino: palabras(termino).filter(palabra => !comunes.has(palabra)), ubicacion };
}

function opciones(select, texto, valores, preferido = select.value) {
  const unicos = [...new Set(valores.filter(Boolean))].sort(ordenarTexto);
  select.replaceChildren(new Option(texto, ""), ...unicos.map(valor => new Option(valor, valor)));
  select.value = unicos.includes(preferido) ? preferido : "";
}

function actualizarUbicacion(preferencias = {}) {
  const porDepartamento = obras.filter(obra => !$("dep").value || obra.departamento === $("dep").value);
  opciones($("prov"), "Todas las provincias", porDepartamento.map(obra => obra.provincia), preferencias.prov);
  const porProvincia = porDepartamento.filter(obra => !$("prov").value || obra.provincia === $("prov").value);
  opciones($("dist"), "Todos los distritos", porProvincia.map(obra => obra.distrito), preferencias.dist);
  $("prov").disabled = !$("dep").value;
  $("dist").disabled = !$("prov").value;
}

function paramsBusqueda() {
  const params = new URLSearchParams();
  for (const id of filtros) {
    const valor = $(id).value.trim();
    if (valor && !(id === "orden" && valor === "original")) params.set(id, valor);
  }
  if (estados.pagina > 1) params.set("pagina", estados.pagina);
  return params;
}

function enlaceFicha(codigo) {
  const params = paramsBusqueda();
  params.set("obra", codigo);
  return "?" + params.toString();
}

function actualizarURL(codigo) {
  const params = paramsBusqueda();
  if (codigo) params.set("obra", codigo);
  const sufijo = params.size ? "?" + params.toString() : "";
  // Los archivos abiertos directamente también permiten enlaces relativos con filtros.
  try {
    history.replaceState(null, "", location.pathname + sufijo);
  } catch {
    // Algunos navegadores restringen history en archivos locales.
  }
}

function buscar({ reiniciar = true, sincronizar = true } = {}) {
  if (reiniciar) estados.pagina = 1;
  const consulta = interpretarConsulta($("q").value);
  const avance = $("avance").value;
  const seleccion = obras.filter(obra => {
    if ($("dep").value && obra.departamento !== $("dep").value) return false;
    if ($("prov").value && obra.provincia !== $("prov").value) return false;
    if ($("dist").value && obra.distrito !== $("dist").value) return false;
    if ($("tipo").value && obra.tipo !== $("tipo").value) return false;
    if (avance === "sin" && obra.avance != null) return false;
    if (avance === "100" && obra.avance !== 100) return false;
    if (avance === "90" && (obra.avance == null || obra.avance < 90)) return false;
    if (consulta.codigo) {
      return consulta.campo ? obra[consulta.campo] === consulta.codigo
        : obra.infobras === consulta.codigo || obra.cui === consulta.codigo;
    }
    const entrada = indice.get(obra.infobras);
    if (consulta.ubicacion && !entrada.ubicaciones.includes(consulta.ubicacion)) return false;
    return consulta.termino.every(palabra =>
      entrada.texto.includes(palabra) || obra.infobras === palabra || obra.cui === palabra);
  });
  const orden = $("orden").value;
  if (orden === "avance" || orden === "costo") {
    seleccion.sort((a, b) => (b[orden] ?? -Infinity) - (a[orden] ?? -Infinity) || a.fila - b.fila);
  }
  estados.resultados = seleccion;
  renderizar();
  if (sincronizar) actualizarURL();
}

function renderizar() {
  const total = estados.resultados.length;
  const paginas = Math.max(1, Math.ceil(total / tamPagina));
  estados.pagina = Math.min(Math.max(estados.pagina, 1), paginas);
  const desde = (estados.pagina - 1) * tamPagina;
  const filas = estados.resultados.slice(desde, desde + tamPagina);
  $("conteo").textContent = `${cantidad.format(total)} ${total === 1 ? "obra encontrada" : "obras encontradas"}`
    + (total > tamPagina ? ` · Mostrando ${cantidad.format(desde + 1)}–${cantidad.format(desde + filas.length)}` : "");
  $("descargar").disabled = !total;
  $("lista").innerHTML = filas.length ? filas.map(obra => `
    <li class="resultado">
      <div>
        <h3><a data-obra="${obra.infobras}" href="${entidadHtml(enlaceFicha(obra.infobras))}">${entidadHtml(obra.obra)}</a></h3>
        <p>${entidadHtml(obra.entidad)} · ${entidadHtml(lugar(obra))}</p>
        <p class="meta">${entidadHtml(obra.tipo)} · INFOBRAS ${obra.infobras}${obra.cui ? ` · CUI ${obra.cui}` : ""}</p>
        <a data-obra="${obra.infobras}" href="${entidadHtml(enlaceFicha(obra.infobras))}" aria-label="Ver ficha INFOBRAS ${obra.infobras}">Ver ficha <span aria-hidden="true">↗</span></a>
      </div>
      <div class="dato"><strong>${obra.avance == null ? "—" : porcentaje(obra.avance)}</strong><span>Avance físico</span></div>
    </li>`).join("") : '<li class="vacio">No hay coincidencias en este corte. Prueba con otro nombre o amplía la ubicación.</li>';
  $("paginacion").hidden = paginas === 1;
  $("pagina").textContent = `Página ${estados.pagina} de ${paginas}`;
  $("anterior").disabled = estados.pagina === 1;
  $("siguiente").disabled = estados.pagina === paginas;
}

function fuenteLink(url, texto) {
  return `<a href="${entidadHtml(url)}" target="_blank" rel="noopener noreferrer">${entidadHtml(texto)} ↗</a>`;
}

function ficha(codigo) {
  const obra = porId.get(codigo);
  if (!obra) return;
  const campos = [
    ["Entidad registrada", obra.entidad],
    ["Nivel de gobierno", obra.nivel],
    ["Unidad orgánica de control", obra.organo],
    ["Avance físico reportado", porcentaje(obra.avance)],
    ["Causal registrada", obra.causa?.replace(/^\d+\s+/, "")],
    ["Modalidad de ejecución", obra.modalidad],
    ["Tipo de obra", obra.tipo],
    ["Categoría", obra.categoria],
    ["Subtipo", obra.subtipo],
    ["Año de inicio", obra.inicio],
    ["Costo de obra según expediente (INFOBRAS)", soles(obra.costo)],
    ["PIM de la inversión para 2026", obra.cui ? soles(obra.pim) : "Sin CUI asociado"],
    ["Registro en el inventario MEF", obra.inventarioMef],
    ["En lista priorizada", obra.priorizada],
  ];
  const documentos = [
    obra.informe && fuenteLink(obra.informe, "Informe de estado situacional" + (obra.fechaInforme ? ` (${obra.fechaInforme})` : "")),
    obra.resolucion && fuenteLink(obra.resolucion, "Resolución de priorización" + (obra.fechaResolucion ? ` (${obra.fechaResolucion})` : "")),
    fuenteLink(anexo, `Anexo 1 · fila ${obra.fila}`),
    fuenteLink("https://www.gob.pe/es/10795-conocer-el-estado-de-las-obras-publicas-en-todo-el-peru-infobras", "Consultar INFOBRAS por código"),
    obra.cui && fuenteLink("https://ofi5.mef.gob.pe/ssi/Ssi/Indexm", "Consultar MEF por CUI"),
  ].filter(Boolean);
  $("detalle").innerHTML = `
    <h2 id="nombre-ficha">${entidadHtml(obra.obra)}</h2>
    <p class="meta">${entidadHtml(lugar(obra))} · Corte al ${fechaCorte}</p>
    <p class="meta">INFOBRAS ${obra.infobras} · CUI ${obra.cui ?? "sin dato"}</p>
    <dl class="campos">${campos.map(([nombre, valor]) =>
      `<div><dt>${entidadHtml(nombre)}</dt><dd>${entidadHtml(valor)}</dd></div>`).join("")}</dl>
    <h3>Documentos y consultas oficiales</h3>
    <ul>${documentos.map(link => `<li>${link}</li>`).join("")}</ul>
    <p class="nota">La entidad y la unidad de control son las que figuran en el anexo. Si un documento externo no abre, consulta INFOBRAS con el código de la obra o el MEF con el CUI.</p>
    <div class="acciones">
      <button type="button" class="button" id="copiar-cita">Copiar referencia</button>
      <button type="button" class="button secondary" id="copiar-enlace">Copiar enlace a la ficha</button>
    </div>
    <details>
      <summary>Preparar un pedido de información</summary>
      <label for="pedido">Borrador editable</label>
      <textarea id="pedido" rows="6"></textarea>
      <button type="button" class="button secondary" id="copiar-pedido">Copiar pedido</button>
    </details>
    <div id="mensaje" role="status"></div>`;
  const id = `INFOBRAS ${obra.infobras}${obra.cui ? `, CUI ${obra.cui}` : ""}`;
  $("pedido").value = `A ${obra.entidad ?? "la entidad a cargo"}:\n\nSolicito información sobre la obra «${obra.obra}» (${id}), incluida en el Anexo 1 de Contraloría al ${fechaCorte}. Agradeceré indicar el estado actual de la obra y facilitar copia del último informe de estado situacional, del acta de recepción si existe y de los documentos que acrediten su puesta en servicio o las acciones previstas para concluirla.\n\nFuente: ${fuente}`;
  const referencia = `Contraloría General de la República. Obras públicas paralizadas al ${fechaCorte}, Anexo 1, fila ${obra.fila}. «${obra.obra}» (${id}). ${fuente}`;
  $("copiar-cita").onclick = () => copiar(referencia);
  $("copiar-enlace").onclick = () => copiar(new URL(enlaceFicha(codigo), location.href).href);
  $("copiar-pedido").onclick = () => copiar($("pedido").value);
  if (!$("ficha").open) $("ficha").showModal();
  $("ficha").scrollTop = 0;
  actualizarURL(codigo);
}

async function copiar(texto) {
  try {
    await navigator.clipboard.writeText(texto);
    $("mensaje").textContent = "Copiado al portapapeles.";
  } catch {
    const caja = document.createElement("textarea");
    caja.setAttribute("aria-label", "Texto para copiar");
    caja.readOnly = true;
    caja.value = texto;
    $("mensaje").replaceChildren("Selecciona y copia el texto.", caja);
    caja.select();
  }
}

function descargar() {
  const columnas = ["infobras", "cui", "obra", "entidad", "departamento", "provincia", "distrito",
    "tipo", "categoria", "subtipo", "avance", "modalidad", "causa", "organo", "costo", "pim",
    "informe", "resolucion", "fila", "corte", "fuente"];
  const celda = valor => {
    const texto = String(valor ?? "");
    const seguro = typeof valor === "string" && /^[\s]*[=+\-@]/.test(texto) ? "'" + texto : texto;
    return '"' + seguro.replace(/"/g, '""') + '"';
  };
  const filas = estados.resultados.map(obra => columnas.map(clave =>
    celda(clave === "corte" ? corte : clave === "fuente" ? fuente :
      clave === "pim" && !obra.cui ? null : obra[clave])).join(","));
  const url = URL.createObjectURL(new Blob(["\ufeff", [columnas.join(","), ...filas].join("\r\n")], { type: "text/csv;charset=utf-8" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = `obras-paralizadas-${corte}.csv`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const inicial = new URLSearchParams(location.search);
$("fuente").href = fuente;
$("anexo").href = anexo;
opciones($("dep"), "Todo el Perú", obras.map(obra => obra.departamento), inicial.get("dep"));
actualizarUbicacion({ prov: inicial.get("prov"), dist: inicial.get("dist") });
opciones($("tipo"), "Todos los tipos", obras.map(obra => obra.tipo), inicial.get("tipo"));
$("q").value = inicial.get("q") ?? "";
if (["90", "100", "sin"].includes(inicial.get("avance"))) $("avance").value = inicial.get("avance");
if (Object.hasOwn(etiquetas, inicial.get("orden"))) $("orden").value = inicial.get("orden");
estados.pagina = Number.parseInt(inicial.get("pagina"), 10) || 1;
buscar({ reiniciar: false, sincronizar: false });
if (inicial.has("obra")) ficha(inicial.get("obra"));

$("busqueda").addEventListener("submit", evento => { evento.preventDefault(); buscar(); });
$("q").addEventListener("input", () => buscar());
$("dep").addEventListener("change", () => { actualizarUbicacion({ prov: "", dist: "" }); buscar(); });
$("prov").addEventListener("change", () => { actualizarUbicacion({ dist: "" }); buscar(); });
for (const id of ["dist", "tipo", "avance", "orden"]) $(id).addEventListener("change", () => buscar());
$("limpiar").onclick = () => {
  $("busqueda").reset();
  for (const id of ["dep", "tipo"]) $(id).value = "";
  $("orden").value = "original";
  actualizarUbicacion({ prov: "", dist: "" });
  buscar();
  $("q").focus();
};
for (const [id, delta] of [["anterior", -1], ["siguiente", 1]]) $(id).onclick = () => {
  estados.pagina += delta;
  renderizar();
  actualizarURL();
  $("lista").querySelector("h3 a")?.focus({ preventScroll: true });
  $("resultados").scrollIntoView();
};
$("lista").addEventListener("click", evento => {
  const link = evento.target.closest("a[data-obra]");
  if (!link || evento.metaKey || evento.ctrlKey || evento.shiftKey || evento.altKey) return;
  evento.preventDefault();
  ficha(link.dataset.obra);
});
$("ficha").addEventListener("close", () => actualizarURL());
$("descargar").onclick = descargar;
