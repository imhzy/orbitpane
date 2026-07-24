#!/bin/bash
echo "ARGS: $@" > /root/agy_web_bridge/agy_wrapper.log
env > /root/agy_web_bridge/agy_wrapper_env.log
/root/.local/bin/agy "$@" > /root/agy_web_bridge/agy_wrapper_stdout.log 2> /root/agy_web_bridge/agy_wrapper_stderr.log
EXIT_CODE=$?
echo "EXIT CODE: $EXIT_CODE" >> /root/agy_web_bridge/agy_wrapper.log
cat /root/agy_web_bridge/agy_wrapper_stdout.log
cat /root/agy_web_bridge/agy_wrapper_stderr.log >&2
exit $EXIT_CODE
