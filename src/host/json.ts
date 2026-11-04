/**
 * The JSON value schema of the host, for values that come from entries and go into the store.
 */
import { type Static, Type } from "typebox";

/** The prototypes of a plain object, which JSON gives and the store takes. */
const PLAIN_PROTOTYPES: readonly unknown[] = [Object.prototype, null];

/**
 * A JSON value: null, a boolean, a finite number, a string, or an array or a plain object of JSON values. A value with
 * `undefined`, a function or a class instance in it is not JSON.
 */
export const Json = Type.Cyclic(
	{
		Json: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("Json")),
			Type.Refine(
				Type.Record(Type.String(), Type.Ref("Json")),
				(value) => PLAIN_PROTOTYPES.includes(Object.getPrototypeOf(value)),
				() => "must be a plain object",
			),
		]),
	},
	"Json",
);

export type Json = Static<typeof Json>;
