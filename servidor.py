"""Sirve el buscador local y permite sugerir preguntas con Codex CLI."""

import argparse
import json
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import subprocess
import tempfile
from threading import Lock

DIST = Path(__file__).resolve().parent / "dist"
RUTA_IA = "/api/ia"
PREGUNTAS = {
    "recepcion": "¿Existe un acta de recepción de la obra? Solicito copia y fecha.",
    "servicio": "¿Cuándo se puso en servicio la infraestructura o qué falta para hacerlo?",
    "avance": "¿Cuál es el último avance físico verificado? Solicito el informe que lo sustenta.",
    "paralizacion": "¿Desde cuándo está paralizada y qué documentos sustentan la causal registrada?",
    "reanudacion": "¿Se aprobó un plan de reanudación? Solicito el cronograma y el expediente de saldo de obra.",
    "presupuesto": "¿Qué recursos están asignados para concluir la obra y qué saldo falta financiar?",
    "contrato": "¿Cuál es la situación del contrato de obra? Solicito las resoluciones o adendas pertinentes.",
    "priorizacion": "¿La obra integra la lista priorizada vigente? Solicito la resolución correspondiente.",
}
SCHEMA = {
    "type": "object",
    "properties": {
        "preguntas": {"type": "array", "items": {"type": "string", "enum": list(PREGUNTAS)}},
    },
    "required": ["preguntas"],
    "additionalProperties": False,
}


def cargar_obras():
    contenido = (DIST / "obras.js").read_text(encoding="utf-8")
    datos = json.loads(contenido.split(" = ", 1)[1].strip().removesuffix(";"))
    return {obra["infobras"]: obra for obra in datos["obras"]}


def sugerir_preguntas(ejecutable, obra):
    hechos = {
        "avance_fisico": obra["avance"],
        "por_contrata": obra["modalidad"] == "Contrata",
        "hay_cui": bool(obra["cui"]),
        "pim_positivo": obra["pim"] > 0 if obra["cui"] and obra["pim"] is not None else None,
        "hay_informe_situacional_en_anexo": bool(obra["informe"]),
        "figura_en_lista_priorizada": {"SI": True, "NO": False}.get(obra["priorizada"]),
    }
    instrucciones = (
        "Selecciona exactamente tres claves distintas de preguntas para pedir información "
        "actualizada sobre una obra pública. Devuelve únicamente el objeto JSON del esquema. "
        "Utiliza solo los datos incluidos abajo, no uses herramientas ni leas archivos. "
        "Con 100 % de avance, prioriza recepción y puesta en servicio. Con avance menor "
        "prioriza evidencia del avance o cronograma de reanudación. El corte no confirma el estado actual."
    )
    prompt = f"{instrucciones}\nDatos: {json.dumps(hechos)}\nPreguntas: {json.dumps(PREGUNTAS, ensure_ascii=False)}"
    with tempfile.TemporaryDirectory(prefix="obras-ia-") as carpeta:
        schema = Path(carpeta) / "schema.json"
        respuesta = Path(carpeta) / "respuesta.json"
        schema.write_text(json.dumps(SCHEMA), encoding="utf-8")
        subprocess.run(
            [
                ejecutable, "exec", "--ephemeral", "--ignore-user-config", "--ignore-rules",
                "--sandbox", "read-only", "--skip-git-repo-check", "--color", "never",
                "--output-schema", str(schema), "--output-last-message", str(respuesta), "-",
            ],
            cwd=carpeta, input=prompt, encoding="utf-8", timeout=45, check=True,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        claves = json.loads(respuesta.read_text(encoding="utf-8")).get("preguntas")
    if (
        not isinstance(claves, list) or len(claves) != 3
        or any(not isinstance(clave, str) or clave not in PREGUNTAS for clave in claves)
        or len(set(claves)) != 3
    ):
        raise ValueError("La IA no devolvió tres preguntas válidas.")
    return [PREGUNTAS[clave] for clave in claves]


class Buscador(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(DIST), **kwargs)

    def enviar_json(self, estado, datos):
        contenido = json.dumps(datos, ensure_ascii=False).encode("utf-8")
        self.send_response(estado)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(contenido)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(contenido)

    def do_GET(self):
        if self.path == RUTA_IA:
            self.enviar_json(HTTPStatus.OK, {"disponible": bool(self.server.codex)})
        else:
            super().do_GET()

    def do_POST(self):
        if self.path != RUTA_IA:
            self.enviar_json(HTTPStatus.NOT_FOUND, {"error": "Ruta no disponible."})
            return
        host = f"127.0.0.1:{self.server.server_port}"
        if self.headers.get("Host") != host or self.headers.get("Origin") != f"http://{host}":
            self.enviar_json(HTTPStatus.FORBIDDEN, {"error": "Abre la dirección local del buscador."})
            return
        try:
            longitud = int(self.headers.get("Content-Length", "0"))
            if self.headers.get_content_type() != "application/json" or not 0 < longitud <= 128:
                raise ValueError
            datos = json.loads(self.rfile.read(longitud))
            codigo = datos.get("infobras") if isinstance(datos, dict) else None
            if not isinstance(codigo, str) or codigo not in self.server.obras:
                raise ValueError
        except (ValueError, UnicodeError):
            self.enviar_json(HTTPStatus.BAD_REQUEST, {"error": "Selecciona una obra del inventario."})
            return
        if not self.server.codex:
            self.enviar_json(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "Codex CLI no está disponible."})
            return
        if not self.server.turno.acquire(blocking=False):
            self.enviar_json(HTTPStatus.TOO_MANY_REQUESTS, {"error": "Ya se están generando preguntas."})
            return
        try:
            preguntas = sugerir_preguntas(self.server.codex, self.server.obras[codigo])
        except (OSError, subprocess.SubprocessError, ValueError, AttributeError):
            self.enviar_json(HTTPStatus.BAD_GATEWAY, {
                "error": "La IA no respondió. Puedes seguir editando el borrador.",
            })
        else:
            self.enviar_json(HTTPStatus.OK, {"preguntas": preguntas})
        finally:
            self.server.turno.release()


def crear_servidor(puerto, codex):
    servidor = ThreadingHTTPServer(("127.0.0.1", puerto), Buscador)
    servidor.obras = cargar_obras()
    servidor.codex = codex
    servidor.turno = Lock()
    return servidor


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--puerto", type=int, default=8000)
    opciones = parser.parse_args()
    with crear_servidor(opciones.puerto, shutil.which("codex")) as servidor:
        print(f"Obras que esperan · http://127.0.0.1:{servidor.server_port}", flush=True)
        try:
            servidor.serve_forever()
        except KeyboardInterrupt:
            pass
