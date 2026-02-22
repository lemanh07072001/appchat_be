import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { Document } from 'mongoose';

export type CountryDocument = Country & Document & {
  createdAt: Date;
  updatedAt: Date;
};

@Schema({ timestamps: true })
export class Country {
  @Prop({ required: true, unique: true })
  name: string;

  @Prop({ default: '' })
  code: string;
}

export const CountrySchema = SchemaFactory.createForClass(Country);
