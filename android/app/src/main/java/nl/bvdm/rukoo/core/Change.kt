package nl.bvdm.rukoo.core

/**
 * A field a call may change: a null `Change` leaves the field alone, `Change(null)` sets it to null
 * (usually "back to the default"). Plain nullable parameters can't tell those apart.
 */
data class Change<out T>(val value: T)
