import json
from http.client import HTTPConnection
from threading import Thread
import unittest
from unittest.mock import patch

from servidor import PREGUNTAS, crear_servidor, sugerir_preguntas


class ServidorTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.servidor = crear_servidor(0, "codex-prueba")
        cls.hilo = Thread(target=cls.servidor.serve_forever, daemon=True)
        cls.hilo.start()

    @classmethod
    def tearDownClass(cls):
        cls.servidor.shutdown()
        cls.servidor.server_close()
        cls.hilo.join()

    def solicitud(self, metodo, ruta, contenido=None, origen=None):
        puerto = self.servidor.server_port
        conexion = HTTPConnection("127.0.0.1", puerto, timeout=5)
        try:
            conexion.request(metodo, ruta, body=contenido, headers={
                "Content-Type": "application/json",
                "Origin": origen or f"http://127.0.0.1:{puerto}",
            })
            respuesta = conexion.getresponse()
            return respuesta.status, respuesta.read()
        finally:
            conexion.close()

    def codigo_vigente(self):
        return next(iter(self.servidor.obras))

    def solicitud_valida(self):
        return json.dumps({"infobras": self.codigo_vigente()}).encode()

    def test_sirve_busqueda_y_disponibilidad(self):
        estado, html = self.solicitud("GET", "/")
        self.assertEqual(estado, 200)
        self.assertIn(b"Obras que esperan", html)
        estado, contenido = self.solicitud("GET", "/api/ia")
        self.assertEqual((estado, json.loads(contenido)), (200, {"disponible": True}))

    def test_valida_origen_y_codigo_antes_de_invocar_el_modelo(self):
        with patch("servidor.sugerir_preguntas") as modelo:
            self.assertEqual(self.solicitud("POST", "/api/ia", self.solicitud_valida(),
                                           origen="https://example.com")[0], 403)
            for invalido in (b'{"infobras":"0"}', b'{"infobras":[]}', b'[]', b'{', b' ' * 129):
                self.assertEqual(self.solicitud("POST", "/api/ia", invalido)[0], 400)
            modelo.assert_not_called()

    def test_devuelve_preguntas_o_mantiene_el_borrador_si_hay_error(self):
        preguntas = [PREGUNTAS[clave] for clave in ("recepcion", "servicio", "avance")]
        with patch("servidor.sugerir_preguntas", return_value=preguntas) as modelo:
            estado, contenido = self.solicitud("POST", "/api/ia", self.solicitud_valida())
            self.assertEqual((estado, json.loads(contenido)), (200, {"preguntas": preguntas}))
            self.assertEqual(modelo.call_args.args[1]["infobras"], self.codigo_vigente())
        with patch("servidor.sugerir_preguntas", side_effect=ValueError):
            estado, contenido = self.solicitud("POST", "/api/ia", self.solicitud_valida())
            self.assertEqual(estado, 502)
            self.assertIn("borrador", json.loads(contenido)["error"])

    def test_protege_consultas_concurrentes(self):
        with self.servidor.turno, patch("servidor.sugerir_preguntas") as modelo:
            estado, _ = self.solicitud("POST", "/api/ia", self.solicitud_valida())
            self.assertEqual(estado, 429)
            modelo.assert_not_called()

    def test_descarta_claves_repetidas_o_ajenas_a_la_lista(self):
        for claves in (["avance", "avance", "servicio"], ["avance", "inventada", "servicio"]):
            def respuesta_mock(argumentos, **_):
                from pathlib import Path
                Path(argumentos[argumentos.index("--output-last-message") + 1]).write_text(
                    json.dumps({"preguntas": claves}), encoding="utf-8",
                )
            with patch("servidor.subprocess.run", side_effect=respuesta_mock):
                with self.assertRaises(ValueError):
                    sugerir_preguntas("codex-prueba", self.servidor.obras[self.codigo_vigente()])
