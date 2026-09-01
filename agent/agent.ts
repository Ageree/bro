import { defineAgent } from "eve";
import { broModel } from "./lib/model";

export default defineAgent(broModel());
