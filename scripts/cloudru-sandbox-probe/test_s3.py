"""s3.py signs for Cloud.ru by default and for another S3 provider (Selectel) when S3_* are set."""

import importlib
import os
import sys
import unittest
import urllib.parse
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parent))

SELECTEL = {"S3_ENDPOINT": "https://s3.ru-1.storage.selcloud.ru", "S3_REGION": "ru-1",
            "S3_ACCESS_KEY_ID": "selectel-key", "S3_SECRET_ACCESS_KEY": "selectel-secret"}
CLOUDRU = {"CLOUDRU_S3_TENANT_ID": "tenant", "CLOUDRU_KEY_ID": "key", "CLOUDRU_KEY_SECRET": "secret"}


def load(env):
    with mock.patch.dict(os.environ, env, clear=True):
        import s3
        return importlib.reload(s3), dict(env)


class ProviderTest(unittest.TestCase):
    def presigned(self, env):
        s3, env = load(env)
        with mock.patch.dict(os.environ, env, clear=True):
            return urllib.parse.urlsplit(s3.presign("GET", "pool/x.tgz", 600))

    def test_cloudru_by_default(self):
        url = self.presigned(CLOUDRU)
        self.assertEqual(url.hostname, "s3.cloud.ru")
        self.assertIn("tenant%3Akey%2F", url.query)
        self.assertIn("ru-central-1", urllib.parse.unquote(url.query))

    def test_another_provider_with_the_four_s3_settings(self):
        url = self.presigned({**CLOUDRU, **SELECTEL})
        self.assertEqual(url.hostname, "s3.ru-1.storage.selcloud.ru")
        credential = urllib.parse.parse_qs(url.query)["X-Amz-Credential"][0]
        self.assertTrue(credential.startswith("selectel-key/"))
        self.assertIn("/ru-1/s3/aws4_request", credential)

    def test_a_half_set_provider_stays_on_cloudru(self):
        url = self.presigned({**CLOUDRU, "S3_ENDPOINT": SELECTEL["S3_ENDPOINT"]})
        self.assertEqual(url.hostname, "s3.cloud.ru")


if __name__ == "__main__":
    unittest.main()
