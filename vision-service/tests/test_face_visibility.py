from __future__ import annotations
import json
import unittest
from types import SimpleNamespace
from unittest.mock import Mock
import numpy as np
from fastapi.testclient import TestClient
from vision_service.config import Settings
from vision_service.face_engine import FaceEngine
from vision_service.main import create_app
from vision_service.runtime import VisionRuntime

MODEL = "5838f7fe053675b1c7a08b633df49e7af5495cee0493c7dcf6697200b85b5b91"

class FakeEngine:
    calls = 0
    def get_active_providers(self): return ["MIGraphXExecutionProvider", "CPUExecutionProvider"]
    def get_embedding_dimension(self): return 512
    def detect(self, image): raise AssertionError("Recognition must not run")
    def close(self): pass
    def observe_visibility(self, image):
        self.calls += 1
        return dict(detected=False, max_confidence=0.0, model_sha256=MODEL,
                    input_size=[640,640], confidence=.5, nms=.4,
                    providers=self.get_active_providers(), identity_embeddings=False, service="shared-vision")

class VisibilityTests(unittest.TestCase):
    def test_engine_reuses_high_gpu_session_at_640_without_recognition(self):
        detector = SimpleNamespace(det_thresh=.5, nms_thresh=.4, model_file="unused",
            session=SimpleNamespace(get_providers=lambda:["MIGraphXExecutionProvider", "CPUExecutionProvider"]),
            detect=Mock(return_value=(np.array([[0,0,4,4,.9]]), None)))
        engine = FaceEngine.__new__(FaceEngine)
        engine.app_high = SimpleNamespace(det_model=detector)
        engine._visibility_model_sha = MODEL
        result = engine.observe_visibility(np.zeros((90,160,3), dtype=np.uint8))
        self.assertTrue(result["detected"])
        self.assertEqual(detector.detect.call_args.kwargs, {"input_size":(640,640)})
        detector.session.get_providers = lambda:["CPUExecutionProvider"]
        with self.assertRaises(RuntimeError): engine.observe_visibility(np.zeros((90,160,3),dtype=np.uint8))

    def test_bounded_endpoint_uses_existing_faces_and_preserves_observed_zero(self):
        settings = Settings(_env_file=None, nudity_enabled=False, clip_enabled=False)
        engine = FakeEngine()
        runtime = VisionRuntime(settings, engine_factory=lambda:engine)
        import cv2
        _, data = cv2.imencode(".png", np.zeros((10,10,3), dtype=np.uint8))
        manifest = json.dumps(dict(version="1", capabilities=["face_visibility"],
            items=[dict(id="42",timestamp_seconds=210,file_field="image_0")]))
        with TestClient(create_app(runtime=runtime)) as client:
            response = client.post("/v1/face-visibility", data={"manifest":manifest}, files={"image_0":("frame.png",data.tobytes(),"image/png")})
            self.assertEqual(response.status_code,200,response.text)
            item = response.json()["items"][0]
            self.assertEqual((item["id"],item["timestamp_seconds"]),("42",210))
            finding=item["outcomes"][0]["findings"][0]
            self.assertFalse(finding["metadata"]["detected"])
            self.assertIsNone(finding["embedding"])
            self.assertEqual(engine.calls,1)
            rejected=client.post("/v1/face-visibility", content=b"", headers={"content-length":str(settings.max_batch_bytes+2*1024*1024)})
            self.assertEqual(rejected.status_code,413)
            self.assertEqual(engine.calls,1)

    def test_failed_observation_is_an_error_not_an_empty_success(self):
        settings = Settings(_env_file=None,nudity_enabled=False,clip_enabled=False)
        engine=FakeEngine()
        engine.observe_visibility=Mock(side_effect=RuntimeError("not ready"))
        runtime=VisionRuntime(settings,engine_factory=lambda:engine)
        import cv2
        _,data=cv2.imencode(".png",np.zeros((10,10,3),dtype=np.uint8))
        manifest=json.dumps(dict(version="1",capabilities=["face_visibility"],items=[dict(id="0",timestamp_seconds=0,file_field="image_0")]))
        with TestClient(create_app(runtime=runtime)) as client:
            response=client.post("/v1/face-visibility",data={"manifest":manifest},files={"image_0":("frame.png",data.tobytes(),"image/png")})
            self.assertEqual(response.status_code,200,response.text)
            self.assertEqual(response.json()["items"][0]["outcomes"][0]["status"],"error")

if __name__ == "__main__": unittest.main()
