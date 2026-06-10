import React, { memo, useEffect, useRef, useState } from 'react';
import {
  dockerIconTileStyle,
  resolveDockerIconPresentation,
  resolveDockerImageIcon,
} from '../../domain/systemManager/dockerImageIcons';
import { cn } from '../../lib/utils';

interface DockerImageIconProps {
  image: string;
  size?: number;
  className?: string;
}

export const DockerImageIcon = memo(function DockerImageIcon({
  image,
  size = 24,
  className,
}: DockerImageIconProps) {
  const iconId = resolveDockerImageIcon(image);
  const [imgFailed, setImgFailed] = useState(false);
  const prevKeyRef = useRef('');

  const resetKey = `${image}\0${iconId}`;
  useEffect(() => {
    if (prevKeyRef.current !== resetKey) {
      prevKeyRef.current = resetKey;
      setImgFailed(false);
    }
  }, [resetKey]);

  const { displayIconId, iconUrl } = resolveDockerIconPresentation(iconId, {
    imageFailed: imgFailed,
  });
  const tile = dockerIconTileStyle(displayIconId);

  const pad = 6;
  const box = size + pad * 2;

  return (
    <div
      className={cn(
        'flex shrink-0 items-center justify-center rounded-md',
        className,
      )}
      style={{
        width: box,
        height: box,
        padding: pad,
        backgroundColor: tile.background,
      }}
    >
      <img
        src={iconUrl}
        alt=""
        width={size}
        height={size}
        className="rounded object-contain"
        onError={() => setImgFailed(true)}
      />
    </div>
  );
});
