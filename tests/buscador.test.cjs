const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { readFile } = require("node:fs/promises");
const { createServer } = require("node:http");
const { resolve } = require("node:path");
const { createInterface } = require("node:readline");
const { pathToFileURL } = require("node:url");
const { after, before, test } = require("node:test");
const { chromium, firefox } = require(process.env.OBRAS_PLAYWRIGHT || "playwright");

require("../dist/obras.js");
const inventario = globalThis.INVENTARIO;
const corteInicial = inventario.corte === "2026-06-30";
const local = pathToFileURL(resolve(__dirname, "../dist/index.html")).href;
let browser;

before(async () => {
  const executablePath = process.env.OBRAS_BROWSER;
  const motor = process.env.OBRAS_MOTOR === "firefox" ? firefox : chromium;
  browser = await motor.launch(executablePath ? { executablePath } : {});
});

after(async () => {
  await browser?.close();
});

async function probar(navegar) {
  const pagina = await browser.newPage({
    viewport: { width: 1360, height: 920 },
    acceptDownloads: true,
  });
  const errores = [];
  pagina.on("pageerror", error => errores.push(error.message));
  try {
    await navegar(pagina);
    assert.deepEqual(errores, []);
  } finally {
    await pagina.close();
  }
}

async function esperarConteo(pagina, total) {
  await pagina.waitForFunction(n => {
    const conteo = document.querySelector("#conteo")?.textContent ?? "";
    return conteo.split(" ")[0].replace(/\D/g, "") === String(n);
  }, total);
}

async function sitioDePrueba(rutas, prueba) {
  const tipos = {
    "/": ["index.html", "text/html; charset=utf-8"],
    "/estilos.css": ["estilos.css", "text/css"],
    "/base.css": ["base.css", "text/css"],
    "/tokens.css": ["tokens.css", "text/css"],
    "/fuentes-tipograficas/bricolage-grotesque.woff2": ["fuentes-tipograficas/bricolage-grotesque.woff2", "font/woff2"],
    "/fuentes-tipograficas/source-serif-4.woff2": ["fuentes-tipograficas/source-serif-4.woff2", "font/woff2"],
    "/buscador.js": ["buscador.js", "text/javascript; charset=utf-8"],
    "/obras.js": ["obras.js", "text/javascript; charset=utf-8"],
  };
  const archivos = new Map(await Promise.all(Object.entries(tipos).map(async ([ruta, [nombre, tipo]]) => (
    [ruta, { tipo, cuerpo: await readFile(resolve(__dirname, "../dist", nombre)) }]
  ))));
  const servidor = createServer(async (peticion, respuesta) => {
    const ruta = new URL(peticion.url, "http://127.0.0.1").pathname;
    const archivo = rutas[ruta] ? await rutas[ruta](peticion) : archivos.get(ruta);
    respuesta.writeHead(archivo?.estado ?? (archivo ? 200 : 404), {
      "Content-Type": archivo?.tipo ?? "text/plain",
      "Cache-Control": "no-store",
    });
    respuesta.end(archivo?.cuerpo ?? "");
  });
  await new Promise(resolveInicio => servidor.listen(0, "127.0.0.1", resolveInicio));
  try {
    await prueba(`http://127.0.0.1:${servidor.address().port}/`);
  } finally {
    await new Promise(resolveCierre => {
      servidor.close(resolveCierre);
      servidor.closeAllConnections();
    });
  }
}

function scriptInventario(datos) {
  return {
    tipo: "text/javascript; charset=utf-8",
    cuerpo: "globalThis.INVENTARIO = " + JSON.stringify(datos) + ";",
  };
}

test("muestra el corte vigente y el total del inventario publicado", () => probar(async pagina => {
  await pagina.goto(local);
  await esperarConteo(pagina, inventario.obras.length);
  assert.equal(await pagina.locator("#corte-portada").getAttribute("datetime"), inventario.corte);
  assert.equal(await pagina.locator("#anexo").getAttribute("href"), inventario.anexo);
  assert.equal(await pagina.locator("#revision-fuente").isVisible(), Boolean(inventario.revisado));
}));

test("ordena por nombre y conserva la opción del orden de la fuente al compartir una ficha", () => probar(async pagina => {
  const obras = ["¿Zanja", "Camino", "Árbol"].map((obra, i) => ({
    ...inventario.obras[0], obra, infobras: String(80000 + i), fila: i + 2,
  }));
  await sitioDePrueba({ "/obras.js": () => scriptInventario({ ...inventario, obras }) }, async url => {
    await pagina.goto(url);
    await esperarConteo(pagina, obras.length);
    const nombres = () => pagina.locator(".resultado h3").allTextContents();
    assert.equal(await pagina.locator("#orden").inputValue(), "nombre");
    assert.deepEqual(await nombres(), ["Árbol", "Camino", "¿Zanja"]);
    await pagina.locator("#orden").selectOption("original");
    assert.deepEqual(await nombres(), ["¿Zanja", "Camino", "Árbol"]);
    const enlace = await pagina.locator(".resultado h3 a").first().getAttribute("href");
    assert.equal(new URL(enlace, url).searchParams.get("orden"), "original");
    await pagina.goto(new URL(enlace, url).href);
    assert.ok(await pagina.locator("#ficha").isVisible());
    assert.equal(await pagina.locator("#orden").inputValue(), "original");
    await pagina.locator("#cerrar-ficha").click();
    await pagina.locator("#limpiar").click();
    assert.equal(new URL(pagina.url()).searchParams.get("orden"), null);
    assert.deepEqual(await nombres(), ["Árbol", "Camino", "¿Zanja"]);
  });
}));

test("distingue los límites del avance físico y mantiene las barras en móvil", () => probar(async pagina => {
  const avances = [0, 39.99, 40, 79.99, 80, 100, null];
  const obras = avances.map((avance, i) => ({
    ...inventario.obras[0], obra: "Obra " + i, infobras: String(81000 + i), fila: i + 2, avance,
  }));
  await sitioDePrueba({ "/obras.js": () => scriptInventario({ ...inventario, obras }) }, async url => {
    await pagina.setViewportSize({ width: 320, height: 720 });
    await pagina.goto(url);
    await esperarConteo(pagina, obras.length);
    const barras = pagina.locator(".resultado progress");
    assert.deepEqual(await barras.evaluateAll(elementos => elementos.map(barra => [barra.value, barra.className])), [
      [0, "avance-bajo"], [39.99, "avance-bajo"], [40, "avance-medio"],
      [79.99, "avance-medio"], [80, "avance-alto"], [100, "avance-alto"],
    ]);
    assert.ok(await barras.first().isVisible());
    assert.equal(await barras.first().evaluate(barra => getComputedStyle(barra).outlineStyle), "solid");
    const colores = await barras.evaluateAll(elementos => elementos.map(barra => getComputedStyle(barra).accentColor));
    assert.equal(new Set(colores).size, 3);
    assert.equal(await pagina.locator(".resultado .dato strong").last().textContent(), "—");
    assert.equal(await pagina.locator(".resultado").last().locator("progress").count(), 0);
  });
}));

test("coinciden la consulta territorial, el total y el CSV del corte inicial", { skip: !corteInicial }, () => probar(async pagina => {
  await pagina.goto(local);
  await esperarConteo(pagina, 2262);
  await pagina.selectOption("#dep", "CUSCO");
  await esperarConteo(pagina, 370);
  await pagina.selectOption("#prov", "LA CONVENCION");
  await esperarConteo(pagina, 92);
  await pagina.selectOption("#dist", "ECHARATE");
  await esperarConteo(pagina, 47);
  const [descarga] = await Promise.all([pagina.waitForEvent("download"), pagina.click("#descargar")]);
  const csv = await readFile(await descarga.path(), "utf8");
  const filas = csv.trimEnd().split(/\r?\n/);
  assert.equal(filas.length, 48);
  assert.ok(filas.slice(1).every(fila => fila.includes('"CUSCO","LA CONVENCION","ECHARATE"')));
  assert.ok(filas.slice(1).every(fila => fila.includes('"2026-06-30"')));
  await pagina.click("#limpiar");
  await pagina.fill("#q", "¿Cuántas obras paralizadas hay en Echarate?");
  await esperarConteo(pagina, 47);
  await pagina.fill("#q", "¿Cuáles son las obras públicas paralizadas en La Convención?");
  await esperarConteo(pagina, 92);
  await pagina.fill("#q", "colegio en Cusco");
  assert.ok(await pagina.locator(".resultado").count() > 0);
  await pagina.click("#limpiar");
  await pagina.selectOption("#avance", "100");
  await esperarConteo(pagina, 23);
  await pagina.selectOption("#avance", "sin");
  await esperarConteo(pagina, 54);
}));

test("exporta los campos de la ficha y enlaces verificables, con o sin CUI", { skip: !corteInicial }, () => probar(async pagina => {
  async function exportar(consulta) {
    await pagina.goto(local + "?" + new URLSearchParams(consulta));
    await esperarConteo(pagina, 1);
    const [descarga] = await Promise.all([
      pagina.waitForEvent("download"), pagina.getByRole("button", { name: "Descargar resultados (CSV)" }).click(),
    ]);
    const [cabecera, fila] = (await readFile(await descarga.path(), "utf8")).replace(/^\uFEFF/, "").trimEnd().split(/\r?\n/);
    const valores = [...fila.matchAll(/"((?:[^"]|"")*)"(?:,|$)/g)].map(grupo => grupo[1].replaceAll('""', '"'));
    return Object.fromEntries(cabecera.split(",").map((clave, i) => [clave, valores[i]]));
  }

  const fila = await exportar({ dep: "JUNIN", prov: "CONCEPCION", dist: "MATAHUASI" });
  assert.deepEqual([fila.infobras, fila.cui, fila.avance, fila.fila, fila.nivel, fila.inicio], ["28117", "2185641", "56.06", "218", "G. LOCAL", "2015"]);
  assert.deepEqual([fila.inventarioMef, fila.priorizada, fila.pim, fila.anioPim], ["NO", "", "0", "2026"]);
  assert.equal(fila.anexo, inventario.anexo);
  assert.equal(fila.ficha, "https://bocchienjoyer.github.io/obras-que-esperan/?obra=28117");
  await pagina.locator('.dato a[data-obra="28117"]').click();
  assert.equal(await pagina.getByRole("link", { name: "Ver obra en INFOBRAS (28117)" }).getAttribute("href"), fila.urlInfobras);
  assert.equal(await pagina.getByRole("link", { name: "Ver inversión en el MEF (CUI 2185641)" }).getAttribute("href"), fila.urlMef);
  assert.equal(fila.urlInfobras, "https://infobras.contraloria.gob.pe/InfobrasWeb/Mapa/Obra?ObraId=28117");
  assert.equal(fila.urlMef, "https://ofi5.mef.gob.pe/ssi/Ssi/Index?codigo=2185641&tipo=2");

  const conInforme = await exportar({ q: "INFOBRAS 5712" });
  const original = inventario.obras.find(obra => obra.infobras === "5712");
  assert.equal(conInforme.informe, original.informe);
  assert.equal(conInforme.fechaInforme, original.fechaInforme);

  const sinCui = await exportar({ q: "INFOBRAS 558323" });
  assert.deepEqual([sinCui.cui, sinCui.urlMef, sinCui.pim, sinCui.anioPim], ["", "", "", ""]);
  await pagina.locator('.dato a[data-obra="558323"]').click();
  assert.equal(await pagina.getByRole("link", { name: /Ver inversión en el MEF/ }).count(), 0);
}));

test("distingue identificadores y conserva la búsqueda al volver de una ficha", { skip: !corteInicial }, () => probar(async pagina => {
  await pagina.goto(local + "?q=CUI+59");
  await esperarConteo(pagina, 0);
  assert.ok(await pagina.locator("#descargar").isDisabled());
  await pagina.fill("#q", "INFOBRAS 59");
  await esperarConteo(pagina, 1);
  await pagina.locator("#lista h3 a").click();
  await pagina.locator("#ficha[open]").waitFor();
  assert.match(await pagina.locator("#detalle").innerText(), /PROGRAMA SUBSECTORIAL DE IRRIGACIONES/);
  await pagina.goBack();
  await pagina.locator("#ficha[open]").waitFor({ state: "hidden" });
  await esperarConteo(pagina, 1);
  assert.equal(await pagina.locator("#q").inputValue(), "INFOBRAS 59");
  await pagina.goForward();
  await pagina.locator("#ficha[open]").waitFor();
  await pagina.getByRole("button", { name: "Cerrar", exact: true }).click();
  await pagina.locator("#ficha[open]").waitFor({ state: "hidden" });
  await pagina.waitForFunction(() => !new URLSearchParams(location.search).has("obra"));
  await pagina.fill("#q", "CUI 2100376");
  await esperarConteo(pagina, 1);
}));

test("abre enlaces de ficha, conserva datos ausentes y funciona en móvil", { skip: !corteInicial }, () => probar(async pagina => {
  await pagina.setViewportSize({ width: 390, height: 844 });
  await pagina.goto(local + "?dep=CUSCO&prov=LA+CONVENCION&dist=ECHARATE&obra=5712");
  await pagina.locator("#ficha[open]").waitFor();
  assert.match(await pagina.locator("#detalle").innerText(), /100 %/);
  assert.match(await pagina.getByRole("link", { name: /Informe de estado situacional/ }).getAttribute("href"), /^https:\/\/ofi5\.mef\.gob\.pe\//);
  await pagina.locator("#ficha summary").click();
  assert.match(await pagina.locator("#pedido").inputValue(), /CUI 2161116/);
  assert.ok(await pagina.getByRole("button", { name: "Sugerir preguntas con IA" }).isHidden());
  await pagina.keyboard.press("Escape");
  await esperarConteo(pagina, 47);
  assert.ok(await pagina.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await pagina.goto(local + "?obra=558323");
  assert.match(await pagina.locator("#detalle").innerText(), /Sin CUI asociado/);
  await pagina.goto(local + "?q=sincoincidenciareal");
  await esperarConteo(pagina, 0);
  await pagina.click("#limpiar");
  await pagina.click("#siguiente");
  assert.match(await pagina.locator("#conteo").innerText(), /13–24/);
}));

test("el contenido y la ficha caben en móvil, tableta y escritorio", () => probar(async pagina => {
  await pagina.goto(local + "?q=INFOBRAS+" + inventario.obras[0].infobras);
  for (const ancho of [320, 360, 390, 768, 1024, 1280]) {
    await pagina.setViewportSize({ width: ancho, height: 800 });
    const cabe = () => pagina.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
    assert.ok(await cabe(), `La página se desborda a ${ancho} px`);
    await pagina.locator("#lista h3 a").click();
    await pagina.locator("#ficha[open]").waitFor();
    assert.ok(await cabe(), `La ficha se desborda a ${ancho} px`);
    await pagina.locator("#cerrar-ficha").click();
    await pagina.locator("#ficha[open]").waitFor({ state: "hidden" });
    assert.ok(await cabe(), `La página se desborda al cerrar a ${ancho} px`);
  }
}));

test("añade sugerencias de Codex al borrador sin perder ediciones", {
  skip: !process.env.OBRAS_IA_REAL, timeout: 65000,
}, () => probar(async pagina => {
  const servidor = spawn(process.env.OBRAS_PYTHON || "python", ["servidor.py", "--puerto", "0"], {
    cwd: resolve(__dirname, ".."), stdio: ["ignore", "pipe", "inherit"],
  });
  const salida = createInterface({ input: servidor.stdout });
  try {
    const url = await new Promise((resolveURL, reject) => {
      servidor.once("error", reject);
      servidor.once("exit", () => reject(new Error("El servidor terminó antes de iniciar.")));
      salida.once("line", linea => {
        const coincidencia = linea.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (coincidencia) resolveURL(coincidencia[0]);
        else reject(new Error("No se encontró la dirección local."));
      });
    });
    const obra = inventario.obras.find(o => o.infobras === "5712") || inventario.obras[0];
    await pagina.goto(url + "/?obra=" + obra.infobras);
    await pagina.locator("#ficha summary").click();
    await pagina.locator("#pedido").fill("Texto revisado por la persona usuaria.");
    await pagina.getByRole("button", { name: "Sugerir preguntas con IA" }).click();
    await pagina.getByText("Se añadieron tres preguntas.", { exact: false }).waitFor({ timeout: 55000 });
    const pedido = await pagina.locator("#pedido").inputValue();
    assert.match(pedido, /^Texto revisado por la persona usuaria\./);
    assert.equal(pedido.split("\n").filter(linea => /^\d\. /.test(linea)).length, 3);
  } finally {
    salida.close();
    servidor.kill();
  }
}));

test("soporta 100 aperturas y cierres de ficha con pulsaciones repetidas", { timeout: 90000 }, () => probar(async pagina => {
  await pagina.goto(local);
  await esperarConteo(pagina, inventario.obras.length);
  const consulta = `INFOBRAS ${inventario.obras[0].infobras}`;
  await pagina.locator("#q").fill(consulta);
  const abrir = pagina.locator("#lista h3 a");
  const dialogo = pagina.locator("#ficha[open]");
  for (let vuelta = 0; vuelta < 100; vuelta++) {
    if (vuelta < 5) await abrir.click();
    else await abrir.evaluate(enlace => { enlace.click(); enlace.click(); enlace.click(); });
    await dialogo.waitFor();
    if (vuelta % 10 === 0) {
      await pagina.keyboard.press("Escape");
    } else {
      await pagina.locator("#cerrar-ficha").evaluate(boton => { boton.click(); boton.click(); boton.click(); });
    }
    await dialogo.waitFor({ state: "hidden" });
  }
  await pagina.waitForFunction(() => !new URLSearchParams(location.search).has("obra"));
  assert.equal(await pagina.locator("#q").inputValue(), consulta);
  await esperarConteo(pagina, 1);
}));

test("resiste 500 cambios de controles con 20.000 registros y una consulta enorme", { timeout: 45000 },
  () => probar(async pagina => {
    const obras = Array.from({ length: 20000 }, (_, i) => ({
      ...inventario.obras[i % inventario.obras.length], infobras: String(9000000 + i), fila: i + 2,
    }));
    await sitioDePrueba({ "/obras.js": () => scriptInventario({ ...inventario, obras }) }, async url => {
      await pagina.goto(url);
      await esperarConteo(pagina, obras.length);
      await pagina.evaluate(() => {
        const buscar = document.getElementById("q");
        const avance = document.getElementById("avance");
        const cambiar = (elemento, evento) => elemento.dispatchEvent(new Event(evento, { bubbles: true }));
        for (let vuelta = 0; vuelta < 100; vuelta++) {
          buscar.value = "colegio ".repeat(25000);
          cambiar(buscar, "input");
          document.getElementById("limpiar").click();
          avance.value = "100";
          cambiar(avance, "change");
          avance.value = "";
          cambiar(avance, "change");
          document.getElementById("siguiente").click();
        }
      });
      await pagina.locator("#limpiar").click();
      await esperarConteo(pagina, obras.length);
      assert.equal(await pagina.locator(".resultado").count(), 12);
      await pagina.locator("#q").fill("x".repeat(200000));
      assert.equal((await pagina.locator("#q").inputValue()).length, 200);
      await esperarConteo(pagina, 0);
      assert.ok(await pagina.locator("#descargar").isDisabled());
    });
  }));

test("informa el fallo y se recupera cuando reaparecen los datos o el buscador", () => probar(async pagina => {
  let fallo = "datos";
  const script = await readFile(resolve(__dirname, "../dist/buscador.js"));
  await sitioDePrueba({
    "/obras.js": () => fallo === "datos" ? { estado: 503 }
      : scriptInventario(fallo === "invalido" ? { ...inventario, corte: "2026-02-30" } : inventario),
    "/buscador.js": () => fallo === "buscador" ? { estado: 503 }
      : { tipo: "text/javascript; charset=utf-8", cuerpo: script },
  }, async url => {
    for (const tipo of ["datos", "invalido", "buscador"]) {
      fallo = tipo;
      await pagina.goto(url);
      await pagina.getByRole("alert").waitFor();
      assert.match(await pagina.locator("#error-carga").innerText(), /Vuelve a cargar/);
      assert.ok(await pagina.locator("#q").isDisabled());
      assert.ok(await pagina.locator("#descargar").isDisabled());
    }
    fallo = "";
    await pagina.getByRole("link", { name: "Vuelve a cargar la página" }).click();
    await esperarConteo(pagina, inventario.obras.length);
    assert.ok(await pagina.locator("#q").isEnabled());
    assert.ok(await pagina.getByRole("alert").isHidden());
  });
}));

test("avisa si la carga se queda colgada y permite seguir buscando después de recuperarse",
  { timeout: 30000 }, () => probar(async pagina => {
    let responder;
    const espera = new Promise(resolveRespuesta => { responder = resolveRespuesta; });
    await sitioDePrueba({ "/obras.js": async () => {
      await espera;
      return scriptInventario(inventario);
    } }, async url => {
      try {
        await pagina.goto(url, { waitUntil: "commit" });
        await pagina.getByRole("alert").waitFor({ timeout: 18000 });
        assert.ok(await pagina.locator("#q").isDisabled());
        responder();
        await esperarConteo(pagina, inventario.obras.length);
        assert.ok(await pagina.getByRole("alert").isHidden());
        await pagina.context().setOffline(true);
        await pagina.locator("#q").fill(`INFOBRAS ${inventario.obras[0].infobras}`);
        await esperarConteo(pagina, 1);
        await pagina.locator("#lista h3 a").click();
        await pagina.locator("#ficha[open]").waitFor();
      } finally {
        responder();
      }
    });
  }));

test("tolera enlaces dañados, portapapeles bloqueado y ráfagas de descarga", () => probar(async pagina => {
  await pagina.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("Portapapeles denegado")) },
    });
  });
  await pagina.goto(local + "?dep=inexistente&avance=101&pagina=9999999999999999999&obra=0");
  assert.ok(await pagina.locator("#aviso-ficha").isVisible());
  assert.ok(await pagina.locator("#siguiente").isDisabled());
  await pagina.locator("#q").fill(`INFOBRAS ${inventario.obras[0].infobras}`);
  assert.ok(await pagina.locator("#aviso-ficha").isHidden());
  let descargas = 0;
  pagina.on("download", () => descargas++);
  const [descarga] = await Promise.all([
    pagina.waitForEvent("download"),
    pagina.locator("#descargar").evaluate(boton => {
      for (let i = 0; i < 100; i++) boton.click();
    }),
  ]);
  const contenido = await readFile(await descarga.path(), "utf8");
  assert.equal(contenido.trimEnd().split(/\r?\n/).length, 2);
  await pagina.locator("#lista h3 a").click();
  await pagina.locator("#copiar-enlace").click();
  const enlace = await pagina.getByRole("textbox", { name: "Texto para copiar" }).inputValue();
  assert.match(enlace, /[?&]obra=\d+/);
  await pagina.locator("#cerrar-ficha").click();
  await pagina.waitForFunction(() => !document.querySelector("#descargar").disabled);
  assert.equal(descargas, 1);
}));

test("si la IA devuelve un error, permite reintentar sin perder el borrador", () => probar(async pagina => {
  let solicitudes = 0;
  const json = (estado, datos) => ({ estado, tipo: "application/json", cuerpo: JSON.stringify(datos) });
  await sitioDePrueba({
    "/api/ia": peticion => {
      if (peticion.method === "GET") return json(200, { disponible: true });
      if (++solicitudes === 1) return json(503, { error: "No disponible" });
      return json(200, { preguntas: ["Primera pregunta", "Segunda pregunta", "Tercera pregunta"] });
    },
  }, async url => {
    await pagina.goto(url + "?obra=" + inventario.obras[0].infobras);
    await pagina.locator("#ficha summary").click();
    const borrador = pagina.locator("#pedido");
    const boton = pagina.locator("#sugerir-preguntas");
    await borrador.fill("Texto importante.");
    await boton.waitFor({ state: "visible" });
    await boton.evaluate(control => { for (let i = 0; i < 20; i++) control.click(); });
    await pagina.getByText("La IA no respondió.", { exact: false }).waitFor();
    assert.equal(await borrador.inputValue(), "Texto importante.");
    assert.equal(solicitudes, 1);
    await boton.click();
    await pagina.getByText("Se añadieron tres preguntas.", { exact: false }).waitFor();
    assert.match(await borrador.inputValue(), /^Texto importante\./);
    assert.equal(solicitudes, 2);
  });
}));
