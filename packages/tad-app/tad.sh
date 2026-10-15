#!/bin/bash
#
# Command-line launcher for Tads on macOS. The Quick Start guide has users
# symlink this script onto their PATH:
#
#   tads [options] file
#
# -f / --foreground (or -h, -v) runs Tads attached to the terminal so its
# output is visible; otherwise it opens a new Tads window and returns.
#
if [ "$(uname)" != 'Darwin' ]; then
  echo "tad.sh is the macOS launcher; on Linux run 'tads' (installed by the deb/rpm package)."
  exit 1
fi

TADS_APP_NAME="Tads.app"
TADS_EXECUTABLE_NAME="Tads"

while getopts ":fvh-:" opt; do
  case "$opt" in
    -)
      case "${OPTARG}" in
        help|version)
          REDIRECT_STDERR=1
          EXPECT_OUTPUT=1
          ;;
        foreground)
          EXPECT_OUTPUT=1
          ;;
      esac
      ;;
    h|v)
      REDIRECT_STDERR=1
      EXPECT_OUTPUT=1
      ;;
    f)
      EXPECT_OUTPUT=1
      ;;
  esac
done

if [ $REDIRECT_STDERR ]; then
  exec 2> /dev/null
fi

if [ $EXPECT_OUTPUT ]; then
  export ELECTRON_ENABLE_LOGGING=1
fi

if [ -z "${TADS_PATH}" ]; then
  # If TADS_PATH isn't set, check /Applications and then ~/Applications
  if [ -x "/Applications/$TADS_APP_NAME" ]; then
    TADS_PATH="/Applications"
  elif [ -x "$HOME/Applications/$TADS_APP_NAME" ]; then
    TADS_PATH="$HOME/Applications"
  else
    echo "Cannot locate $TADS_APP_NAME, it is usually located in /Applications. Set the TADS_PATH environment variable to the directory containing $TADS_APP_NAME."
    exit 1
  fi
fi

if [ $EXPECT_OUTPUT ]; then
  "$TADS_PATH/$TADS_APP_NAME/Contents/MacOS/$TADS_EXECUTABLE_NAME" --executed-from="$(pwd)" "$@"
  exit $?
else
  open -a "$TADS_PATH/$TADS_APP_NAME" -n --args --executed-from="$(pwd)" "$@"
fi
