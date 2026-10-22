import tempfile
import unittest
from pathlib import Path

import onnx
from onnx import TensorProto, helper

from vision_service.face_engine import fixed_shape_model


class FixedShapeModelTest(unittest.TestCase):
    def test_pins_the_input_shape_in_a_separate_copy(self):
        with tempfile.TemporaryDirectory() as root:
            source = Path(root) / "det.onnx"
            graph = helper.make_graph(
                [helper.make_node("Identity", ["input"], ["output"])],
                "det",
                [helper.make_tensor_value_info("input", TensorProto.FLOAT, [1, 3, "h", "w"])],
                [helper.make_tensor_value_info("output", TensorProto.FLOAT, [1, 3, "h", "w"])],
            )
            onnx.save(helper.make_model(graph), str(source))

            pinned = fixed_shape_model(source, 1280, Path(root) / "fixed")

            dims = onnx.load(str(pinned)).graph.input[0].type.tensor_type.shape.dim
            self.assertEqual([d.dim_value for d in dims], [1, 3, 1280, 1280])
            self.assertEqual(pinned.name, "det_1280.onnx")
            source_dims = onnx.load(str(source)).graph.input[0].type.tensor_type.shape.dim
            self.assertEqual(source_dims[2].dim_param, "h")
            self.assertEqual(fixed_shape_model(source, 1280, Path(root) / "fixed"), pinned)


if __name__ == "__main__":
    unittest.main()
