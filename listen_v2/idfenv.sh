# Source this to get a working ESP-IDF v5.4.4 environment on this machine.
#   source idfenv.sh
# Works around the broken default activation (system python3 is 3.14, and the
# expected python_env venv was never created; a good venv exists elsewhere).
unset -f idf.py 2>/dev/null
export IDF_PATH=/Users/khawceline03/.espressif/v5.4.4/esp-idf
export IDF_TOOLS_PATH=/Users/khawceline03/.espressif
export IDF_PYTHON_ENV_PATH=/Users/khawceline03/.espressif/tools/python/v5.4.4/venv
export IDF_PYTHON_CHECK_CONSTRAINTS=0
source "$IDF_PATH/export.sh"
