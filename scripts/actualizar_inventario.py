"""Busca cortes más recientes en el compendio oficial y actualiza el inventario validado."""

import argparse
import calendar
from datetime import date, datetime, timedelta, timezone
from html.parser import HTMLParser
from pathlib import PurePosixPath
import re
from urllib.parse import unquote, urljoin, urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener

from preparar_datos import guardar, leer_inventario, normalizar, preparar

GOB = "https://www.gob.pe"
COLECCION = GOB + "/institucion/contraloria/colecciones/18230-obras-paralizadas-documentos"
HORA_PERU = timezone(timedelta(hours=-5))
MESES = {
    mes: i for i, mes in enumerate(
        "enero febrero marzo abril mayo junio julio agosto setiembre octubre noviembre diciembre".split(), 1
    )
}
MESES["septiembre"] = 9
INFORME = re.compile(
    r"/institucion/contraloria/informes-publicaciones/"
    r"(\d+)-(?:informe|reporte)-de-obras-(?:publicas-)?paralizadas-en-el-territorio-nacional-"
    r"a-([a-z]+)-(?:de-)?(20\d{2})/?$"
)


def destino_oficial(url):
    partes = urlsplit(url)
    if partes.scheme != "https" or partes.netloc not in ("www.gob.pe", "cdn.www.gob.pe"):
        raise ValueError("La fuente redirigió fuera de los dominios oficiales esperados.")


class RedireccionOficial(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        destino_oficial(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def descargar(url, limite):
    destino_oficial(url)
    peticion = Request(url, headers={"User-Agent": "Obras-que-esperan/1.0 (inventario oficial)"})
    with build_opener(RedireccionOficial()).open(peticion, timeout=25) as respuesta:
        destino_oficial(respuesta.geturl())
        contenido = respuesta.read(limite + 1)
    if not contenido or len(contenido) > limite:
        raise ValueError("Respuesta oficial vacía o demasiado grande para el formato esperado.")
    return contenido


class Enlaces(HTMLParser):
    def __init__(self, pagina, html):
        super().__init__(convert_charrefs=True)
        self.urls = set()
        self.pagina = pagina
        self.feed(html)

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            href = dict(attrs).get("href")
            if href:
                self.urls.add(urljoin(self.pagina, href))


def localizar_corte(html, hoy):
    candidatos = []
    for url in Enlaces(COLECCION, html).urls:
        partes = urlsplit(url)
        if partes.scheme != "https" or partes.netloc != "www.gob.pe":
            continue
        coincidencia = INFORME.fullmatch(partes.path)
        if not coincidencia:
            continue
        identificador, mes, anio = coincidencia.groups()
        if mes not in MESES:
            continue
        anio, mes = int(anio), MESES[mes]
        corte = date(anio, mes, calendar.monthrange(anio, mes)[1])
        if corte <= hoy:
            candidatos.append((corte, int(identificador), GOB + partes.path.rstrip("/")))
    if not candidatos:
        raise ValueError("No se identificaron informes nacionales en el compendio oficial.")
    corte, _, fuente = max(candidatos)
    return corte, fuente


def localizar_anexo(fuente, html):
    candidatos = set()
    for url in Enlaces(fuente, html).urls:
        partes = urlsplit(url)
        if partes.scheme != "https" or partes.netloc != "cdn.www.gob.pe":
            continue
        archivo = PurePosixPath(unquote(partes.path))
        titulo = normalizar(archivo.stem)
        if (partes.path.startswith("/uploads/document/file/") and archivo.suffix.lower() == ".xlsx"
                and "anexo" in titulo and "obras" in titulo and "paralizadas" in titulo
                and ("lista" in titulo or "inventario" in titulo)
                and not any(palabra in titulo for palabra in ("servicios de control", "principales obras"))):
            candidatos.add(url)
    if len(candidatos) != 1:
        raise ValueError("El enlace al inventario nacional XLSX está ausente o es ambiguo.")
    return candidatos.pop()


def actualizar(actual, hoy, obtener=descargar):
    html = obtener(COLECCION, 2_000_000).decode("utf-8")
    corte, fuente = localizar_corte(html, hoy)
    vigente = date.fromisoformat(actual["corte"])
    if corte < vigente:
        raise ValueError("El compendio no contiene el corte vigente. Se conserva el inventario.")
    if corte == vigente and fuente == actual["fuente"]:
        print(f"No hay un corte posterior al {vigente}.")
        return {**actual, "revisado": hoy.isoformat()}
    if corte == vigente:
        raise ValueError("El mismo corte tiene una publicación diferente. Requiere revisión.")
    anexo = localizar_anexo(fuente, obtener(fuente, 2_000_000).decode("utf-8"))
    datos = preparar(obtener(anexo, 10_000_000), corte, fuente, anexo)
    anterior = len(actual["obras"])
    nuevo = len(datos["obras"])
    zonas = {obra["departamento"] for obra in datos["obras"]}
    cobertura_previa = {obra["departamento"] for obra in actual["obras"]}
    if nuevo * 2 < anterior or nuevo > anterior * 2 or len(zonas) < len(cobertura_previa) - 2:
        raise ValueError(f"Cambio atípico de tamaño o cobertura ({anterior} → {nuevo} obras). Requiere revisión.")
    print(f"Corte {corte} validado: {nuevo} obras.")
    return {**datos, "revisado": hoy.isoformat()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--comprobar", action="store_true", help="Valida sin guardar cambios.")
    args = parser.parse_args()
    actual = leer_inventario()
    datos = actualizar(actual, datetime.now(HORA_PERU).date())
    if datos != actual and not args.comprobar:
        guardar(datos)
