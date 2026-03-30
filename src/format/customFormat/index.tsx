import { makeAutoObservable } from "mobx";
import { MainApp, getAppStores } from "@core/MainApp";
import { clamp, makeId } from "@core/Util";
import { UnitOfLength, UnitConverter, Quantity } from "@core/Unit";
import { GeneralConfig, convertFormat } from "../Config";
import { Format, importPDJDataFromTextFile } from "../Format";
import { Control, EndControl, Path, SegmentVariant, Segment, SpeedKeyframe, Vector } from "@core/Path";
import {
  AddKeyframe,
  AddCubicSegment,
  AddLinearSegment,
  ConvertSegment,
  InsertControls,
  InsertPaths
} from "@core/Command";
import { PointCalculationResult, getPathPoints } from "@core/Calculation";
import { BackQuoteString, CodePointBuffer } from "@token/Tokens";
import { UserInterface } from "@core/Layout";
import { PathConfigImpl, PathConfigPanel } from "./PathConfig";
import { GeneralConfigImpl } from "./GeneralConfig";

import { PathConfigImpl as CustomPathConfigImpl } from "./PathConfig";

// observable class
export class CustomFormat implements Format {
  isInit: boolean = false;
  uid: string;

  private gc = new GeneralConfigImpl(this);

  private readonly disposers: (() => void)[] = [];

  constructor() {
    this.uid = makeId(10);
    makeAutoObservable(this);
  }

  createNewInstance(): Format {
    return new CustomFormat();
  }

  getName(): string {
    return "Custom Format";
  }

  getDescription(): string {
    return "Silly";
  }

  register(app: MainApp, ui: UserInterface): void {
    if (this.isInit) return;
    this.isInit = true;

    this.disposers.push(
      app.history.addEventListener("beforeExecution", event => {
        if (event.isCommandInstanceOf(AddKeyframe)) {
          const keyframe = event.command.keyframe;
          if (keyframe instanceof SpeedKeyframe) {
            keyframe.followBentRate = true;
          }
        }
      }),
      ui.registerPanel(PathConfigPanel).disposer
    );
  }

  unregister(): void {
    this.disposers.forEach(disposer => disposer());
  }

  getGeneralConfig(): GeneralConfig {
    return this.gc;
  }

  createPath(...segments: Segment[]): Path {
    return new Path(new PathConfigImpl(this), ...segments);
  }

  getPathPoints(path: Path): PointCalculationResult {
    const uc = new UnitConverter(this.gc.uol, UnitOfLength.Inch);

    const result = getPathPoints(path, new Quantity(this.gc.pointDensity, this.gc.uol), {
      defaultFollowBentRate: true
    });

    const pc = path.pc as PathConfigImpl;
    const rate = pc.maxDecelerationRate;
    const minSpeed = pc.speedLimit.from;

    if (result.points.length > 1) {
      // the speed of the final point should always be 0
      // set the speed of the segment end point to 0
      result.points[result.points.length - 2].speed = 0;
    }

    for (let i = result.points.length - 3; i >= 0; i--) {
      const last = result.points[i + 1];
      const current = result.points[i];

      // v = sqrt(v_0^2 + 2ad)
      const newSpeed = Math.sqrt(Math.pow(last.speed, 2) + 2 * rate * uc.fromAtoB(last.distance(current)));
      current.speed = Math.max(Math.min(current.speed, newSpeed), minSpeed);
    }
    return result;
  }

  convertFromFormat(oldFormat: Format, oldPaths: Path[]): Path[] {
    const newPaths = convertFormat(this, oldFormat, oldPaths);

    return newPaths;
  }

  importPathsFromFile(buffer: ArrayBuffer): Path[] {
    // ALGO: The implementation is adopted from https://github.com/LemLib/Path-Gen under the GPLv3 license.

    const fileContent = new TextDecoder().decode(buffer);

    const paths: Path[] = [];

    // find the first line that is "endData"
    const lines = fileContent.split("\n");

    let i = lines.findIndex(line => line.trim() === "endData");
    if (i === -1) throw new Error("Invalid file format, unable to find line 'endData'");

    const maxDecelerationRate = Number(lines[i + 1]);
    if (isNaN(maxDecelerationRate)) throw new Error("Invalid file format, unable to parse max deceleration rate");

    const maxSpeed = Number(lines[i + 2]);
    if (isNaN(maxSpeed)) throw new Error("Invalid file format, unable to parse max speed");

    // i + 3 Multiplier not supported.

    i += 4;

    const error = () => {
      throw new Error("Invalid file format, unable to parse segment at line " + (i + 1));
    };

    const num = (str: string): number => {
      const num = Number(str);
      if (isNaN(num)) error();
      return num; // ALGO: removed fix precision
    };

    const push = (segment: Segment) => {
      // check if there is a path
      if (paths.length === 0) {
        const path = this.createPath(segment);
        path.pc.speedLimit.to = clamp(
          maxSpeed.toUser(),
          path.pc.speedLimit.minLimit.value,
          path.pc.speedLimit.maxLimit.value
        );
        (path.pc as PathConfigImpl).maxDecelerationRate = maxDecelerationRate;
        paths.push(path);
      } else {
        const path = paths[paths.length - 1];
        const lastSegment = path.segments[path.segments.length - 1];
        const a = lastSegment.last;
        const b = segment.first;

        if (a.x !== b.x || a.y !== b.y) error();

        path.segments.push(segment);
      }
    };

    while (i < lines.length - 1) {
      // ALGO: the last line is always empty, follow the original implementation.
      const line = lines[i];
      const tokens = line.split(", ");
      if (tokens.length !== 8) error();

      const p1 = new EndControl(num(tokens[0]), num(tokens[1]), 0);
      const p2 = new Control(num(tokens[2]), num(tokens[3]));
      const p3 = new Control(num(tokens[4]), num(tokens[5]));
      const p4 = new EndControl(num(tokens[6]), num(tokens[7]), 0);
      const segment = new Segment(p1, p2, p3, p4);
      push(segment);

      i++;
    }

    return paths;
  }

  // TODO: actually implement
  importPathsFromCodeSnippet(buffer: ArrayBuffer): Path[] {
    // ALGO: The implementation is adopted from https://github.com/LemLib/Path-Gen under the GPLv3 license.

    const fileContent = new TextDecoder().decode(buffer);

    const paths: Path[] = [];

    // find the first line that is "endData"
    const lines = fileContent.split("\n");

    let i = lines.findIndex(line => line.trim() === "endData");
    if (i === -1) throw new Error("Invalid file format, unable to find line 'endData'");

    const maxDecelerationRate = Number(lines[i + 1]);
    if (isNaN(maxDecelerationRate)) throw new Error("Invalid file format, unable to parse max deceleration rate");

    const maxSpeed = Number(lines[i + 2]);
    if (isNaN(maxSpeed)) throw new Error("Invalid file format, unable to parse max speed");

    // i + 3 Multiplier not supported.

    i += 4;

    const error = () => {
      throw new Error("Invalid file format, unable to parse segment at line " + (i + 1));
    };

    const num = (str: string): number => {
      const num = Number(str);
      if (isNaN(num)) error();
      return num; // ALGO: removed fix precision
    };

    const push = (segment: Segment) => {
      // check if there is a path
      if (paths.length === 0) {
        const path = this.createPath(segment);
        path.pc.speedLimit.to = clamp(
          maxSpeed.toUser(),
          path.pc.speedLimit.minLimit.value,
          path.pc.speedLimit.maxLimit.value
        );
        (path.pc as PathConfigImpl).maxDecelerationRate = maxDecelerationRate;
        paths.push(path);
      } else {
        const path = paths[paths.length - 1];
        const lastSegment = path.segments[path.segments.length - 1];
        const a = lastSegment.last;
        const b = segment.first;

        if (a.x !== b.x || a.y !== b.y) error();

        path.segments.push(segment);
      }
    };

    while (i < lines.length - 1) {
      // ALGO: the last line is always empty, follow the original implementation.
      const line = lines[i];
      const tokens = line.split(", ");
      if (tokens.length !== 8) error();

      const p1 = new EndControl(num(tokens[0]), num(tokens[1]), 0);
      const p2 = new Control(num(tokens[2]), num(tokens[3]));
      const p3 = new Control(num(tokens[4]), num(tokens[5]));
      const p4 = new EndControl(num(tokens[6]), num(tokens[7]), 0);
      const segment = new Segment(p1, p2, p3, p4);
      push(segment);

      i++;
    }

    return paths;
  }

  importPDJDataFromFile(buffer: ArrayBuffer): Record<string, any> | undefined {
    return importPDJDataFromTextFile(buffer);
  }

  exportFile(): ArrayBufferView<ArrayBufferLike> {
    const { app } = getAppStores();

    // ALGO: The implementation is adopted from https://github.com/LemLib/Path-Gen under the GPLv3 license.

    let fileContent = "";

    const path = app.interestedPath();
    if (path === undefined) throw new Error("No path to export");
    if (path.segments.length === 0) throw new Error("No segment to export");

    const uc = new UnitConverter(this.gc.uol, UnitOfLength.Inch);

    const points = this.getPathPoints(path).points;
    for (const point of points) {
      // ALGO: heading is not supported in LemLib V0.4 format.
      fileContent += `${uc.fromAtoB(point.x).toUser()}, ${uc.fromAtoB(point.y).toUser()}, ${point.speed.toUser()}\n`;
    }

    if (points.length < 3) throw new Error("The path is too short to export");

    /*
    Here is the original code of how the ghost point is calculated:

    ```cpp
    // create a "ghost point" at the end of the path to make stopping nicer
    const lastPoint = path.points[path.points.length-1];
    const lastControl = path.segments[path.segments.length-1].p2;
    const ghostPoint = Vector.interpolate(Vector.distance(lastControl, lastPoint) + 20, lastControl, lastPoint);
    ```

    Notice that the variable "lastControl" is not the last control point, but the second last control point.
    This implementation is different from the original implementation by using the last point and the second last point.
    */
    // ALGO: use second and third last points, since first and second last point are always identical
    const last2 = points[points.length - 3]; // third last point, last point by the calculation
    const last1 = points[points.length - 2]; // second last point, also the last control point
    // ALGO: The 20 inches constant is a constant value in the original LemLib-Path-Gen implementation.
    const ghostPoint = last2.interpolate(last1, last2.distance(last1) + uc.fromBtoA(20));
    fileContent += `${uc.fromAtoB(ghostPoint.x).toUser()}, ${uc.fromAtoB(ghostPoint.y).toUser()}, 0\n`;

    fileContent += `endData\n`;
    fileContent += `${(path.pc as PathConfigImpl).maxDecelerationRate}\n`;
    fileContent += `${path.pc.speedLimit.to}\n`;
    fileContent += `200\n`; // Not supported

    function output(control: Vector, postfix: string = ", ") {
      fileContent += `${uc.fromAtoB(control.x).toUser()}, ${uc.fromAtoB(control.y).toUser()}${postfix}`;
    }

    for (const segment of path.segments) {
      if (segment.isCubic()) {
        output(segment.controls[0]);
        output(segment.controls[1]);
        output(segment.controls[2]);
        output(segment.controls[3], "\n");
      } else if (segment.isLinear()) {
        const center = segment.controls[0].add(segment.controls[1]).divide(2);
        output(segment.controls[0]);
        output(center);
        output(center);
        output(segment.controls[1], "\n");
      }
    }

    fileContent += "#PATH.JERRYIO-DATA " + JSON.stringify(app.exportPDJData());

    return new TextEncoder().encode(fileContent);
  }

  private getTemplatesSet(): { [key: string]: string } {
    const template = this.gc.outputTemplate;
    const rtn: { [key: string]: string } = {};

    const cpb = new CodePointBuffer(template);

    while (cpb.hasNext()) {
      const key = cpb.readSafeChunk();
      const colon = cpb.next();

      if (key === "" || colon !== ":") {
        // skip this line
        while (cpb.hasNext() && cpb.next() !== "\n") {}
        continue;
      }

      cpb.readDelimiter();

      const value = BackQuoteString.parse(cpb);
      if (value === null) break;

      rtn[key] = value.content;

      // skip this line
      while (cpb.hasNext() && cpb.next() !== "\n") {}
    }

    return rtn;
  }

  private applyTemplate(template: string, values: { [key: string]: number | boolean | string }): string {
    return template.replace(/\${([^}]+)}/g, (_, key) => (values[key] ?? "") + "");
  }

  private exportHolonomicMovementCode(path: Path, templates: { [key: string]: string }) {
    let rtn = "";

    const pc = path.pc as PathConfigImpl;

    for (const segment of path.segments) {
      if (segment.isCubic()) {
        rtn +=
          this.applyTemplate(templates.curve ?? "", {
            name: segment.controls[0].name + "_TO_" + segment.controls[3].name,
            x0: segment.controls[0].x.toUser(),
            y0: segment.controls[0].y.toUser(),
            x1: segment.controls[1].x.toUser(),
            y1: segment.controls[1].y.toUser(),
            x2: segment.controls[2].x.toUser(),
            y2: segment.controls[2].y.toUser(),
            x3: segment.controls[3].x.toUser(),
            y3: segment.controls[3].y.toUser()
          }) + "\n";
      } else if (segment.isLinear()) {
        rtn +=
          this.applyTemplate(templates.moveToPoint ?? "", {
            name: segment.controls[0].name + "_TO_" + segment.controls[1].name,
            x0: segment.controls[0].x.toUser(),
            y0: segment.controls[0].y.toUser(),
            x1: segment.controls[1].x.toUser(),
            y1: segment.controls[1].y.toUser()
          }) + "\n";
      }
    }

    return rtn;
  }

  exportCode(): string {
    const { app } = getAppStores();

    let rtn = "";

    const templates = this.getTemplatesSet();

    app.paths.forEach(path => {
      rtn += this.applyTemplate(templates.path ?? "", {
        name: path.name,
        code: this.exportHolonomicMovementCode(path, templates)
      });
    });

    return rtn;
  }
}
