"""Exercise the Windows entry point without launching a GUI or GPU worker."""
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == "nt", "Windows CMD entry point")
class ProviderLauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="relay launcher ")
        self.addCleanup(self.temporary.cleanup)
        self.directory = Path(self.temporary.name)
        self.launcher = self.directory / "START-PROVIDER.cmd"
        shutil.copyfile(Path(__file__).parents[1] / "START-PROVIDER.cmd", self.launcher)

    def run_launcher(self, source=None, argument=None):
        if source is not None:
            provider = self.directory / "provider"
            provider.mkdir()
            (provider / "setup_gui.py").write_text(source, encoding="utf-8")
            # The CMD must dispatch through the updater, which then starts setup.
            (provider / "update_launcher.py").write_text(
                "import runpy\nprint('UPDATER_WAS_CALLED')\n"
                "runpy.run_path('provider/setup_gui.py', run_name='__main__')\n", encoding="utf-8")
        command = 'cmd.exe /d /s /c ""' + str(self.launcher) + '"'
        if argument is not None:
            command += ' "' + argument + '"'
        command += '"'
        return subprocess.run(command, input="\n", text=True, capture_output=True,
                              timeout=15, cwd=self.directory.parent)

    def test_cmd_alone_explains_full_extraction(self):
        result = self.run_launcher()
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("Extract ALL files", result.stdout)

    def test_python_startup_error_remains_visible(self):
        result = self.run_launcher("raise RuntimeError('visible-startup-error')\n")
        self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
        self.assertIn("visible-startup-error", result.stderr)
        self.assertIn("Relay PC setup could not start", result.stdout)

    def test_success_preserves_working_directory_and_path_argument(self):
        argument = str(self.directory / "connection with spaces.json")
        source = ("from pathlib import Path\nimport sys\n"
                  "assert Path.cwd() == Path(__file__).resolve().parents[1]\n"
                  "assert sys.argv[1] == " + repr(argument) + "\n"
                  "print('SETUP_COMPLETED')\n")
        result = self.run_launcher(source, argument)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("UPDATER_WAS_CALLED", result.stdout)
        self.assertIn("SETUP_COMPLETED", result.stdout)
        self.assertNotIn("could not start", result.stdout)


if __name__ == "__main__":
    unittest.main()
