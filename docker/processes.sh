# Sourced by testnode-entrypoint.sh before it starts anything. The first background process to exit
# stops the container with that process's status and names it, so `docker inspect` and the log show
# the cause.

PROCESSES=""

# PROCESSES is a space-separated list of pid:name (dash has no arrays), so a name must not contain
# spaces or colons.
start_background() {
	local name="$1"
	shift
	"$@" &
	PROCESSES="$PROCESSES $!:$name"
}

cleanup() {
	local entry
	for entry in $PROCESSES; do
		kill "${entry%%:*}" 2>/dev/null || true
	done
	wait || true
}

# Must run in the main shell, not a $(...) subshell: only the parent can reap a child and read its
# status.
exit_if_a_process_exited() {
	local entry pid status
	for entry in $PROCESSES; do
		pid="${entry%%:*}"
		if ! kill -0 "$pid" 2>/dev/null; then
			status=0
			wait "$pid" || status=$?
			echo "testnode: ${entry#*:} (pid $pid) exited with status $status${1:+ while waiting for $1}" >&2
			if [ "$status" -eq 0 ]; then
				exit 1
			fi
			exit "$status"
		fi
	done
}

monitor_pids() {
	while true; do
		exit_if_a_process_exited
		sleep 1
	done
}

# Exiting on a signal, rather than returning to monitor_pids, keeps a stop from being reported as
# whichever process cleanup killed first.
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
