import { ApiProperty } from '@nestjs/swagger';
import { IsInt, IsString, Matches, Max, MaxLength, Min } from 'class-validator';

export class CreateProduct {
  @ApiProperty({ example: 'CAMISA-BAHIA-M' })
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  sku!: string;

  @ApiProperty({ example: 10 })
  @IsInt()
  @Min(0)
  @Max(1000000)
  stock!: number;
}

export class CreateHold {
  @ApiProperty({ example: 'CAMISA-BAHIA-M' })
  @IsString()
  @MaxLength(64)
  sku!: string;

  @ApiProperty({ example: 2 })
  @IsInt()
  @Min(1)
  @Max(1000000)
  quantity!: number;

  @ApiProperty({ example: 300, maximum: 3600 })
  @IsInt()
  @Min(1)
  @Max(3600)
  ttlSeconds!: number;
}
