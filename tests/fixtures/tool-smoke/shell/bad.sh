#!/bin/bash
# Tool-smoke fixture for #209 — shellcheck flags the unquoted $name (SC2086);
# shfmt flags the non-canonical leading indentation below.
name=world
  echo Hello $name
