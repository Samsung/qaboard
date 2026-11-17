"""
The README shows a screenshot the docs website serves. Its file name changes when the shot is captured again:
this test fails then, until the README has the new name (website/media.json, the light theme's poster or image).
"""
import json
import re
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class TestReadmeMedia(unittest.TestCase):
  def test_media_are_published(self):
    readme = (ROOT / "README.md").read_text()
    keys = re.findall(r"https://samsung\.github\.io/qaboard/media/([\w./-]+)", readme)
    self.assertTrue(keys, "the README should show a screenshot from the docs website")
    manifest = (ROOT / "website" / "media.json").read_text()
    published = set(re.findall(r'"key": "([^"]+)"', manifest))
    self.assertTrue(json.loads(manifest)["shots"])
    for key in keys:
      self.assertIn(key, published, f"{key} is not in website/media.json: update the README's image")


if __name__ == "__main__":
  unittest.main()
