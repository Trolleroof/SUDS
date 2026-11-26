"""Compute a crossfade over the unexecuted overlap of two action chunks."""

from itertools import takewhile


def handoff_weights(pending_steps, incoming_steps, handoff_steps):
    """Return new-plan weights for the leading overlap in timestep order."""
    overlap = sum(1 for _ in takewhile(pending_steps.__contains__, incoming_steps))
    length = min(overlap, handoff_steps)
    # Smoothstep starts on the queued target and tapers to the new plan.
    weights = {}
    for index, step in enumerate(incoming_steps[:length]):
        progress = index / max(1, length - 1)
        weights[step] = progress**2 * (3 - 2 * progress)
    return weights
