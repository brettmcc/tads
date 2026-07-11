import * as React from "react";
import { Sidebar } from "./Sidebar";
import { StateRef, mutableGet } from "oneref";
import { AppState } from "../AppState";
import * as reltab from "reltab";
import * as log from "loglevel";
import _, { throttle } from "lodash";

import {
  Classes,
  Icon,
  Intent,
  TreeNodeInfo,
  Position,
  Tooltip,
  Tree,
  IconName,
} from "@blueprintjs/core";
import { useState, useReducer, useRef, useEffect } from "react";
import {
  DataSourceKind,
  DataSourceNode,
  DataSourcePath,
  DataSourceId,
  DataSourceConnection,
} from "reltab";
import { actions } from "../tadviewer";

export interface DataSourceSidebarProps {
  expanded: boolean;
  stateRef: StateRef<AppState>;
}

const dataKindIcon = (dsKind: DataSourceKind): IconName => {
  switch (dsKind) {
    case "Database":
      return "database";
    case "Dataset":
      return "folder-open";
    case "Table":
      return "th";
    case "File":
      return "document";
    case "Directory":
      return "folder-close";
    default:
      throw new Error("dataKindIcon: unknown kind '" + dsKind + "'");
  }
};

type DSTreeNodeData = {
  dsc: DataSourceConnection;
  dsPath: DataSourcePath;
  dsNode: DataSourceNode;
};

type DSTreeNodeInfo = TreeNodeInfo<DSTreeNodeData>;

/**
 * Reconstruct the full path a tree node refers to: the data source's
 * root (a file or directory path for local files) joined with the
 * path segments below it.
 */
const dsNodeFullPath = (dsPath: DataSourcePath): string => {
  const root = String(dsPath.sourceId.resourceId);
  const segs = dsPath.path.filter((seg) => seg !== ".");
  if (segs.length === 0) {
    return root;
  }
  const sep = root.includes("\\") ? "\\" : "/";
  return root.replace(/[\\/]+$/, "") + sep + segs.join(sep);
};

const dsNodeTreeNode = (
  dsc: DataSourceConnection,
  dsPath: DataSourcePath,
  dsNode: DataSourceNode,
  onClose?: (e: React.MouseEvent<HTMLElement>) => void
): DSTreeNodeInfo => {
  const ret: DSTreeNodeInfo = {
    icon: dataKindIcon(dsNode.kind),
    id: JSON.stringify(dsPath),
    // the title tooltip shows the full path at the cursor on hover
    label: (
      <span title={dsNodeFullPath(dsPath)} data-testid="ds-node-label">
        {dsNode.displayName}
      </span>
    ),
    nodeData: { dsc, dsPath, dsNode },
    hasCaret: dsNode.isContainer,
  };
  const closeButton = onClose ? (
    <span
      className="ds-node-close"
      data-testid="ds-close-button"
      title="Close connection"
      onClick={onClose}
    >
      <Icon icon="small-cross" />
    </span>
  ) : null;
  if (dsNode.description) {
    ret.secondaryLabel = (
      <>
        <Tooltip
          usePortal={true}
          boundary="window"
          content={dsNode.description}
        >
          <Icon icon="eye-open" />
        </Tooltip>
        {closeButton}
      </>
    );
  } else if (closeButton) {
    ret.secondaryLabel = closeButton;
  }
  return ret;
};

const extendDSPath = (basePath: DataSourcePath, item: string) => ({
  ...basePath,
  path: basePath.path.concat([item]),
});

type RootNodeMap = { [resourceId: string]: DSTreeNodeInfo };

export const DataSourceSidebar: React.FC<DataSourceSidebarProps> = ({
  expanded,
  stateRef,
}) => {
  const [initialized, setInitialized] = useState(false);
  const [treeState, setTreeState] = useState<DSTreeNodeInfo[]>([]);
  const [rootNodeMap, setRootNodeMap] = useState<RootNodeMap>({});
  const [selectedNode, setSelectedNode] = useState<DSTreeNodeInfo | null>(null);
  const [, forceUpdate] = useReducer((x) => x + 1, 0);
  const throttledRefresh = useRef(
    throttle(async function refreshDataSources(): Promise<void> {
      const appState = mutableGet(stateRef);
      const rtc = appState.rtc;
      let dirty = false;
      let newContainers: DSTreeNodeInfo[] = [];
      try {
        const nextNodeMap = Object.assign(rootNodeMap) as RootNodeMap;
        const rootSources = await rtc.getDataSources();
        const rootNodes = await Promise.all(
          rootSources.map(async (sourceId) => {
            const sourceIdStr = JSON.stringify(sourceId);
            let rootTreeNode = nextNodeMap[sourceIdStr];
            if (!rootTreeNode) {
              const dsc = await rtc.connect(sourceId);
              const rootNode = await dsc.getRootNode();
              const rootPath: DataSourcePath = {
                sourceId,
                path: ["."],
              };
              /*
              log.debug(
                "DataSourceSidebar: creating root node for",
                sourceIdStr,
                rootPath,
                rootNode
              );
              */
              rootTreeNode = dsNodeTreeNode(dsc, rootPath, rootNode, (e) =>
                handleCloseSource(e, sourceId)
              );
              nextNodeMap[sourceIdStr] = rootTreeNode;
              if (rootNode.isContainer) {
                newContainers.push(rootTreeNode);
              }
              dirty = true;
            }
            return rootTreeNode;
          })
        );
        if (dirty) {
          setTreeState(rootNodes);
          setRootNodeMap(nextNodeMap);
          for (const cNode of newContainers) {
            handleNodeExpand(cNode);
          }
        }
      } catch (err) {
        console.error("error refreshing data sources: ", err);
      }
    }, 500)
  );

  useEffect(() => {
    throttledRefresh.current();
  });

  const handleCloseSource = async (
    e: React.MouseEvent<HTMLElement>,
    sourceId: DataSourceId
  ) => {
    // don't let the click select or open the node being closed
    e.stopPropagation();
    try {
      // deregister on the server first so a pending sidebar refresh
      // can't re-add the node from a stale getDataSources result
      await actions.closeDataSource(sourceId, stateRef);
    } catch (err) {
      console.error("error closing data source: ", err);
      return;
    }
    const sourceIdStr = JSON.stringify(sourceId);
    delete rootNodeMap[sourceIdStr];
    setTreeState((prev) =>
      prev.filter(
        (node) => JSON.stringify(node.nodeData!.dsPath.sourceId) !== sourceIdStr
      )
    );
    setSelectedNode((prev) =>
      prev != null &&
      JSON.stringify(prev.nodeData!.dsPath.sourceId) === sourceIdStr
        ? null
        : prev
    );
  };

  const handleNodeCollapse = (treeNode: DSTreeNodeInfo) => {
    treeNode.isExpanded = false;
    forceUpdate();
  };
  const handleNodeExpand = async (treeNode: DSTreeNodeInfo) => {
    const { dsPath, dsc, dsNode } = treeNode.nodeData!;
    const appState = mutableGet(stateRef);
    const childNodes = await dsc.getChildren(dsPath);
    treeNode.childNodes = childNodes.map((childNode) => {
      const childPath = extendDSPath(dsPath, childNode.id);
      return dsNodeTreeNode(dsc, childPath, childNode);
    });
    treeNode.isExpanded = true;
    forceUpdate();
  };

  const handleNodeClick = async (
    treeNode: DSTreeNodeInfo,
    _nodePath: any[],
    e: React.MouseEvent<HTMLElement>
  ) => {
    const { dsPath, dsNode } = treeNode.nodeData!;
    if (dsNode.kind === "Table" || dsNode.kind === "File") {
      actions.openDataSourcePath(dsPath, stateRef);
    }
    if (selectedNode != null) {
      selectedNode.isSelected = false;
    }
    treeNode.isSelected = true;
    setSelectedNode(treeNode);
    forceUpdate();
  };

  return (
    <Sidebar expanded={expanded}>
      <Tree
        contents={treeState}
        onNodeCollapse={handleNodeCollapse}
        onNodeExpand={handleNodeExpand}
        onNodeClick={handleNodeClick}
      />
    </Sidebar>
  );
};

const INITIAL_STATE: DSTreeNodeInfo[] = [
  {
    id: 0,
    hasCaret: true,
    icon: "folder-close",
    label: "Folder 0",
  },
  {
    id: 1,
    icon: "folder-close",
    isExpanded: true,
    label: (
      <Tooltip content="I'm a folder <3" position={Position.RIGHT}>
        Folder 1
      </Tooltip>
    ),
    childNodes: [
      {
        id: 2,
        icon: "document",
        label: "Item 0",
        secondaryLabel: (
          <Tooltip content="An eye!">
            <Icon icon="eye-open" />
          </Tooltip>
        ),
      },
      {
        id: 3,
        icon: (
          <Icon
            icon="tag"
            intent={Intent.PRIMARY}
            className={Classes.TREE_NODE_ICON}
          />
        ),
        label:
          "Organic meditation gluten-free, sriracha VHS drinking vinegar beard man.",
      },
      {
        id: 4,
        hasCaret: true,
        icon: "folder-close",
        label: (
          <Tooltip content="foo" position={Position.RIGHT}>
            Folder 2
          </Tooltip>
        ),
        childNodes: [
          { id: 5, label: "No-Icon Item" },
          { id: 6, icon: "tag", label: "Item 1" },
          {
            id: 7,
            hasCaret: true,
            icon: "folder-close",
            label: "Folder 3",
            childNodes: [
              { id: 8, icon: "document", label: "Item 0" },
              { id: 9, icon: "tag", label: "Item 1" },
            ],
          },
        ],
      },
    ],
  },
  {
    id: 2,
    hasCaret: true,
    icon: "folder-close",
    label: "Super secret files",
    disabled: true,
  },
];
