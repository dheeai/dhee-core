import { dheeStatus } from "./status.js";
import { dheeListItems } from "./listItems.js";
import { dheeListProjects } from "./listProjects.js";
import { dheeNew } from "./newProject.js";
import { dheeRunTo } from "./runTo.js";
import { dheeInvalidate } from "./invalidate.js";
import { dheeReadArtifact } from "./readArtifact.js";
import { dheeDescribeImage } from "./describeImage.js";
import { dheeRenderSceneBundle } from "./renderSceneBundle.js";
import { dheeTaskStatus } from "./taskStatus.js";
import { dheeTaskCancel } from "./taskCancel.js";
import {
  dheeShowFirstFrame,
  dheeShowLastFrame,
  dheeShowShotVideo,
  dheeShowFinalVideo,
} from "./showAsset.js";
import {
  dheeValidateComfyWorkflow,
  dheeAnalyzeComfyWorkflow,
  dheeSaveComfyWorkflow,
  dheeListComfyWorkflows,
  dheeUpdateComfyWorkflow,
  dheeDeleteComfyWorkflow,
} from "./comfyui/index.js";

export const dheeTools = [
  dheeListProjects,
  dheeStatus,
  dheeListItems,
  dheeNew,
  dheeRunTo,
  dheeInvalidate,
  dheeReadArtifact,
  dheeDescribeImage,
  dheeRenderSceneBundle,
  dheeTaskStatus,
  dheeTaskCancel,
  dheeShowFirstFrame,
  dheeShowLastFrame,
  dheeShowShotVideo,
  dheeShowFinalVideo,
  dheeValidateComfyWorkflow,
  dheeAnalyzeComfyWorkflow,
  dheeSaveComfyWorkflow,
  dheeListComfyWorkflows,
  dheeUpdateComfyWorkflow,
  dheeDeleteComfyWorkflow,
];

export {
  dheeStatus,
  dheeListItems,
  dheeListProjects,
  dheeNew,
  dheeRunTo,
  dheeInvalidate,
  dheeReadArtifact,
  dheeDescribeImage,
  dheeRenderSceneBundle,
  dheeTaskStatus,
  dheeTaskCancel,
  dheeShowFirstFrame,
  dheeShowLastFrame,
  dheeShowShotVideo,
  dheeShowFinalVideo,
  dheeValidateComfyWorkflow,
  dheeAnalyzeComfyWorkflow,
  dheeSaveComfyWorkflow,
  dheeListComfyWorkflows,
  dheeUpdateComfyWorkflow,
  dheeDeleteComfyWorkflow,
};
